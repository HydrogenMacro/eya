//! Authenticated machine tools carried over the existing encrypted request channel.
use crate::files::FileManager;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    env, io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::PathBuf,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

// Aggregate counters only: collecting chart history never scans process tables.
// Keep one bounded history for this server's configured host identity.
const HISTORY_LIMIT: usize = 601;
static HISTORY: OnceLock<Mutex<ResourceHistory>> = OnceLock::new();
struct ResourceHistory {
    root: PathBuf,
    samples: VecDeque<Value>,
}
struct ResourceCounters {
    at: Instant,
    total: u64,
    idle: u64,
    received: u64,
    sent: u64,
    memory: u64,
    swap: u64,
}
async fn aggregate_text(path: PathBuf, limit: u64) -> io::Result<String> {
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other("aggregate counters exceed limit"));
    }
    String::from_utf8(bytes).map_err(|_| invalid("invalid aggregate counters"))
}
async fn resource_counters(root: &std::path::Path) -> io::Result<ResourceCounters> {
    let (cpu, memory, network) = tokio::try_join!(
        aggregate_text(root.join("stat"), 512 * 1024),
        aggregate_text(root.join("meminfo"), 64 * 1024),
        aggregate_text(root.join("net/dev"), 512 * 1024)
    )?;
    let counters: Vec<u64> = cpu
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(|value| value.parse().unwrap_or(0))
        .collect();
    let mem = |key: &str| {
        memory
            .lines()
            .find(|line| line.starts_with(key))
            .map(|line| number(line.split_whitespace().nth(1)).saturating_mul(1024))
            .unwrap_or(0)
    };
    let (received, sent) = network
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.trim() != "lo")
        .fold((0u64, 0u64), |(rx, tx), (_, line)| {
            let values: Vec<_> = line.split_whitespace().collect();
            (
                rx.saturating_add(number(values.first().copied())),
                tx.saturating_add(number(values.get(8).copied())),
            )
        });
    Ok(ResourceCounters {
        at: Instant::now(),
        total: counters.iter().sum(),
        idle: counters.get(3).unwrap_or(&0) + counters.get(4).unwrap_or(&0),
        received,
        sent,
        memory: mem("MemTotal:").saturating_sub(mem("MemAvailable:")),
        swap: mem("SwapTotal:").saturating_sub(mem("SwapFree:")),
    })
}
fn resource_sample(
    next: &ResourceCounters,
    previous: Option<&ResourceCounters>,
    time: u64,
) -> Value {
    let total = previous
        .map(|before| next.total.saturating_sub(before.total))
        .unwrap_or(0);
    let cpu = previous.filter(|_| total > 0).map(|before| {
        (100.0 * (1.0 - next.idle.saturating_sub(before.idle) as f64 / total as f64))
            .clamp(0.0, 100.0)
    });
    let elapsed = previous
        .map(|before| next.at.duration_since(before.at).as_secs_f64())
        .unwrap_or(0.0);
    let rate = |value: u64, prior: u64| {
        (elapsed > 0.0).then(|| value.saturating_sub(prior) as f64 / elapsed)
    };
    json!({"time":time,"cpu":cpu,"memory":next.memory,"swap":next.swap,
        "rx":previous.and_then(|before| rate(next.received,before.received)),
        "tx":previous.and_then(|before| rate(next.sent,before.sent))})
}
fn retain_sample(history: &mut ResourceHistory, sample: Value) {
    let cutoff = sample["time"].as_u64().unwrap_or(0).saturating_sub(300_000);
    while history
        .samples
        .front()
        .is_some_and(|entry| entry["time"].as_u64().unwrap_or(0) < cutoff)
        || history.samples.len() >= HISTORY_LIMIT
    {
        history.samples.pop_front();
    }
    history.samples.push_back(sample);
}
pub fn start_history(files: &FileManager) {
    let root = proc_root(files);
    if HISTORY
        .set(Mutex::new(ResourceHistory {
            root: root.clone(),
            samples: VecDeque::new(),
        }))
        .is_err()
    {
        return;
    }
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_millis(500));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut previous = None;
        loop {
            timer.tick().await;
            if let Ok(Ok(next)) = timeout(Duration::from_secs(2), resource_counters(&root)).await {
                let time = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let sample = resource_sample(&next, previous.as_ref(), time);
                if let Some(history) = HISTORY.get()
                    && let Ok(mut history) = history.lock()
                {
                    retain_sample(&mut history, sample);
                }
                previous = Some(next);
            } else {
                previous = None;
            }
        }
    });
}
fn history_response(request: &Value, files: &FileManager) -> Option<Value> {
    let offer = request.get("history")?;
    if offer["v"].as_u64() != Some(1) {
        return None;
    }
    let after = offer["after"].as_u64().unwrap_or(0);
    let history = HISTORY.get()?.lock().ok()?;
    if history.root != proc_root(files) {
        return None;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Some(
        json!({"v":1,"now":now,"samples":history.samples.iter().filter(|sample| sample["time"].as_u64().unwrap_or(0) > after).collect::<Vec<_>>()}),
    )
}
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{Duration, timeout},
};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn string<'a>(request: &'a Value, key: &str) -> io::Result<&'a str> {
    request
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("missing command argument"))
}
fn identifier(value: &str) -> io::Result<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        || value.starts_with('-')
    {
        return Err(invalid("invalid container or project identifier"));
    }
    Ok(value)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// A host-mode deployment must execute tools as the same login user as its PTY.
fn command(program: &str, args: &[String]) -> io::Result<Command> {
    let mut command = if let Ok(pid) = env::var("EYA_HOST_PID") {
        if pid.parse::<u32>().ok().filter(|pid| *pid > 0).is_none() {
            return Err(invalid("invalid host PID"));
        }
        let user = env::var("EYA_HOST_USER").map_err(|_| invalid("EYA_HOST_USER is required"))?;
        if user.is_empty() || user.starts_with('-') {
            return Err(invalid("invalid host user"));
        }
        let mut command =
            Command::new(env::var_os("EYA_NSENTER").unwrap_or_else(|| "/usr/bin/nsenter".into()));
        let mut script = format!("exec {}", quote(program));
        for arg in args {
            script.push(' ');
            script.push_str(&quote(arg));
        }
        command.args([
            "--target", &pid, "--mount", "--uts", "--ipc", "--net", "--pid", "--root", "--wdns=/",
            "--",
        ]);
        command.arg(env::var_os("EYA_HOST_SU").unwrap_or_else(|| "/bin/su".into()));
        command.args(["--login", "--command", &script, "--", &user]);
        command
    } else {
        let mut command = Command::new(program);
        command.args(args);
        command
    };
    command
        .env_remove("EYA_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok(command)
}

async fn run_capture(program: &str, args: Vec<String>) -> io::Result<(String, String)> {
    let mut child = command(program, &args)?.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            io::Error::new(error.kind(), format!("{program} is not installed"))
        } else {
            error
        }
    })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let result = timeout(Duration::from_secs(12), async {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        // Return as soon as either pipe exceeds its bound. Waiting for child
        // exit after a capped read leaves the child blocked writing a full pipe.
        let (_, _, status) = tokio::try_join!(
            bounded_output(&mut stdout, &mut output, 512 * 1024),
            bounded_output(&mut stderr, &mut errors, 32 * 1024),
            child.wait()
        )?;
        if !status.success() {
            let message = String::from_utf8_lossy(&errors).trim().to_string();
            return Err(io::Error::other(if message.is_empty() {
                format!("{program} exited with {status}")
            } else {
                message
            }));
        }
        Ok((
            String::from_utf8_lossy(&output).into_owned(),
            String::from_utf8_lossy(&errors).into_owned(),
        ))
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "machine command timed out",
            ))
        }
    }
}
async fn bounded_output<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    output: &mut Vec<u8>,
    limit: usize,
) -> io::Result<()> {
    reader.take(limit as u64 + 1).read_to_end(output).await?;
    if output.len() > limit {
        return Err(io::Error::other(
            "command output exceeds limit; use a narrower query",
        ));
    }
    Ok(())
}
async fn run(program: &str, args: Vec<String>) -> io::Result<String> {
    run_capture(program, args).await.map(|(stdout, _)| stdout)
}

fn proc_root(files: &FileManager) -> PathBuf {
    files.resolve("/proc", "/").1
}
fn number(value: Option<&str>) -> u64 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}
fn parse_stat(value: &str) -> Option<(String, char, u64, u64, u64)> {
    // comm may itself contain spaces, parentheses, or newlines.
    let begin = value.find('(')?;
    let end = value.rfind(')')?;
    let fields: Vec<_> = value[end + 1..].split_whitespace().collect();
    if fields.len() < 22 {
        return None;
    }
    Some((
        value[begin + 1..end].to_string(),
        fields[0].chars().next()?,
        number(fields.get(11).copied()) + number(fields.get(12).copied()),
        number(fields.get(19).copied()),
        number(fields.get(21).copied()),
    ))
}

async fn stats(files: &FileManager) -> io::Result<Value> {
    let root = proc_root(files);
    let (cpu, memory, uptime, load) = tokio::try_join!(
        tokio::fs::read_to_string(root.join("stat")),
        tokio::fs::read_to_string(root.join("meminfo")),
        tokio::fs::read_to_string(root.join("uptime")),
        tokio::fs::read_to_string(root.join("loadavg"))
    )?;
    let values: Vec<u64> = cpu
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(|value| value.parse().unwrap_or(0))
        .collect();
    let total: u64 = values.iter().sum();
    let idle = values.get(3).unwrap_or(&0) + values.get(4).unwrap_or(&0);
    let cpus = cpu
        .lines()
        .filter(|line| {
            line.starts_with("cpu") && line.as_bytes().get(3).is_some_and(u8::is_ascii_digit)
        })
        .count();
    let cores: Vec<Value> = cpu.lines().filter(|line| line.starts_with("cpu") && line.as_bytes().get(3).is_some_and(u8::is_ascii_digit)).map(|line| {
        let mut fields = line.split_whitespace(); let id = fields.next().unwrap_or("");
        let values: Vec<u64> = fields.take(8).map(|value| value.parse().unwrap_or(0)).collect();
        json!({"id":id,"total":values.iter().sum::<u64>(),"idle":values.get(3).unwrap_or(&0)+values.get(4).unwrap_or(&0)})
    }).collect();
    let mem = |name: &str| {
        memory
            .lines()
            .find(|line| line.starts_with(name))
            .map(|line| number(line.split_whitespace().nth(1)) * 1024)
            .unwrap_or(0)
    };
    let mut processes = Vec::new();
    let mut dir = tokio::fs::read_dir(&root).await?;
    let pagesize = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(1) as u64;
    while let Some(entry) = dir.next_entry().await? {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let path = entry.path();
        let Ok(data) = tokio::fs::read_to_string(path.join("stat")).await else {
            continue;
        };
        let Some((name, state, ticks, started, rss)) = parse_stat(&data) else {
            continue;
        };
        let status = tokio::fs::read_to_string(path.join("status"))
            .await
            .unwrap_or_default();
        let uid = status
            .lines()
            .find(|line| line.starts_with("Uid:"))
            .map(|line| number(line.split_whitespace().nth(1)));
        // Never expose environment variables or unbounded process arguments.
        let command = tokio::fs::File::open(path.join("cmdline")).await;
        let mut bytes = Vec::new();
        if let Ok(file) = command {
            let _ = file.take(256).read_to_end(&mut bytes).await;
        }
        let command = String::from_utf8_lossy(&bytes)
            .replace('\0', " ")
            .trim()
            .to_string();
        let field = |key: &str| {
            status
                .lines()
                .find(|line| line.starts_with(key))
                .map(|line| number(line.split_whitespace().nth(1)))
                .unwrap_or(0)
        };
        let stat_fields: Vec<_> = data[data.rfind(')').unwrap_or(0) + 1..]
            .split_whitespace()
            .collect();
        processes.push(json!({"pid":pid,"ppid":number(stat_fields.get(1).copied()),"name":name,"state":state.to_string(),"ticks":ticks,"startTicks":started,"rss":rss.saturating_mul(pagesize),"uid":uid,"command":command,"threads":field("Threads:"),"virtualBytes":field("VmSize:")*1024,"nice":stat_fields.get(16).and_then(|value|value.parse::<i64>().ok()).unwrap_or(0)}));
        if processes.len() == 8192 {
            break;
        }
    }
    processes.sort_by_key(|process| process["pid"].as_u64());
    let network = tokio::fs::read_to_string(root.join("net/dev"))
        .await
        .unwrap_or_default();
    let (rx, tx) = network
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.trim() != "lo")
        .fold((0u64, 0u64), |(rx, tx), (_, line)| {
            let fields: Vec<_> = line.split_whitespace().collect();
            (
                rx.saturating_add(number(fields.first().copied())),
                tx.saturating_add(number(fields.get(8).copied())),
            )
        });
    let interfaces: Vec<Value> = network.lines().filter_map(|line|line.split_once(':')).filter(|(name,_)|name.trim()!="lo").map(|(name,line)|{
        let fields: Vec<_> = line.split_whitespace().collect(); json!({"name":name.trim(),"received":number(fields.first().copied()),"sent":number(fields.get(8).copied())})
    }).collect();
    Ok(
        json!({"cpu":{"total":total,"idle":idle,"count":cpus,"cores":cores},"memory":{"total":mem("MemTotal:"),"available":mem("MemAvailable:"),"cached":mem("Cached:"),"buffers":mem("Buffers:"),"swapTotal":mem("SwapTotal:"),"swapFree":mem("SwapFree:")},"uptime":uptime.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),"load":load.split_whitespace().take(3).collect::<Vec<_>>(),"network":{"received":rx,"sent":tx,"interfaces":interfaces},"processes":processes,"limited":processes.len()==8192}),
    )
}

async fn process_details(request: &Value, files: &FileManager) -> io::Result<Value> {
    let pid = request["pid"]
        .as_u64()
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .ok_or_else(|| invalid("invalid process PID"))?;
    let expected = request["startTicks"]
        .as_u64()
        .ok_or_else(|| invalid("process identity required"))?;
    let path = proc_root(files).join(pid.to_string());
    let stat = tokio::fs::read_to_string(path.join("stat")).await?;
    if parse_stat(&stat).map(|value| value.3) != Some(expected) {
        return Err(invalid("process identity changed"));
    }
    async fn bounded(files: &FileManager, path: &str, limit: u64) -> String {
        let mut data = Vec::new();
        if let Ok(file) = files.open(path).await {
            let _ = file.take(limit).read_to_end(&mut data).await;
        }
        String::from_utf8_lossy(&data)
            .replace('\0', " ")
            .trim()
            .to_owned()
    }
    let status = bounded(files, &format!("/proc/{pid}/status"), 16384).await;
    let command = bounded(files, &format!("/proc/{pid}/cmdline"), 4096).await;
    let io = bounded(files, &format!("/proc/{pid}/io"), 4096).await;
    let cwd = files
        .read_link(&format!("/proc/{pid}/cwd"))
        .await
        .ok()
        .map(|value| value.to_string_lossy().to_string());
    let executable = files
        .read_link(&format!("/proc/{pid}/exe"))
        .await
        .ok()
        .map(|value| value.to_string_lossy().to_string());
    let stat = tokio::fs::read_to_string(path.join("stat")).await?;
    if parse_stat(&stat).map(|value| value.3) != Some(expected) {
        return Err(invalid("process identity changed"));
    }
    Ok(
        json!({"pid":pid,"startTicks":expected,"command":command,"status":status,"io":io,"cwd":cwd,"executable":executable}),
    )
}

pub async fn handle(op: &str, request: &Value, files: &FileManager) -> io::Result<Value> {
    match op {
        "system.stats" => {
            let mut response = stats(files).await?;
            if let Some(history) = history_response(request, files) {
                response["history"] = history;
            }
            Ok(response)
        }
        "system.process" => process_details(request, files).await,
        "system.signal" => {
            let pid = request["pid"]
                .as_u64()
                .filter(|pid| *pid > 1 && *pid <= i32::MAX as u64)
                .ok_or_else(|| invalid("invalid process PID"))?;
            if env::var_os("EYA_HOST_PID").is_none() && pid == std::process::id() as u64 {
                return Err(invalid("cannot signal the Eya server"));
            }
            // Bind native signals to a process handle before checking start time,
            // so a PID recycled after the check cannot target another process.
            let process_fd = if env::var_os("EYA_HOST_PID").is_none() {
                let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
                if raw < 0 {
                    return Err(io::Error::last_os_error());
                }
                Some(unsafe { OwnedFd::from_raw_fd(raw as i32) })
            } else {
                None
            };
            let expected = request["startTicks"]
                .as_u64()
                .ok_or_else(|| invalid("process identity is required"))?;
            let data =
                tokio::fs::read_to_string(proc_root(files).join(pid.to_string()).join("stat"))
                    .await?;
            if parse_stat(&data).is_none_or(|(_, _, _, actual, _)| actual != expected) {
                return Err(invalid("process changed; refresh before signaling"));
            }
            let signal = string(request, "signal")?;
            if !["TERM", "KILL", "STOP", "CONT"].contains(&signal) {
                return Err(invalid("unsupported signal"));
            }
            if let Some(fd) = process_fd {
                let code = match signal {
                    "TERM" => libc::SIGTERM,
                    "KILL" => libc::SIGKILL,
                    "STOP" => libc::SIGSTOP,
                    _ => libc::SIGCONT,
                };
                if unsafe {
                    libc::syscall(
                        libc::SYS_pidfd_send_signal,
                        fd.as_raw_fd(),
                        code,
                        std::ptr::null::<libc::siginfo_t>(),
                        0,
                    )
                } < 0
                {
                    return Err(io::Error::last_os_error());
                }
            } else {
                run(
                    "/bin/kill",
                    vec![format!("-{signal}"), "--".into(), pid.to_string()],
                )
                .await?;
            }
            Ok(json!({"pid":pid}))
        }
        "docker.list" => {
            let output = run(
                "docker",
                vec![
                    "ps".into(),
                    "-a".into(),
                    "--no-trunc".into(),
                    "--format".into(),
                    "{{json .}}".into(),
                ],
            )
            .await?;
            let containers = output
                .lines()
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| invalid("invalid Docker response"))?;
            let stats = run(
                "docker",
                vec![
                    "stats".into(),
                    "--no-stream".into(),
                    "--format".into(),
                    "{{json .}}".into(),
                ],
            )
            .await;
            let usage: Vec<Value> = stats
                .as_ref()
                .ok()
                .map(|text| {
                    text.lines()
                        .filter_map(|line| serde_json::from_str(line).ok())
                        .collect()
                })
                .unwrap_or_default();
            Ok(
                json!({"containers":containers,"usage":usage,"statsError":stats.err().map(|error|error.to_string())}),
            )
        }
        "docker.resources" => {
            let kind = string(request, "kind")?;
            if !["images", "networks", "volumes"].contains(&kind) {
                return Err(invalid("unsupported Docker resource"));
            }
            let command = match kind {
                "images" => "image",
                "networks" => "network",
                _ => "volume",
            };
            let text = run(
                "docker",
                vec![
                    command.into(),
                    "ls".into(),
                    "--format".into(),
                    "{{json .}}".into(),
                ],
            )
            .await?;
            let items = text
                .lines()
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| invalid("invalid Docker resource response"))?;
            Ok(json!({"items":items}))
        }
        "docker.resource.inspect" => {
            let kind = string(request, "kind")?;
            let command = match kind {
                "images" => "image",
                "networks" => "network",
                "volumes" => "volume",
                _ => return Err(invalid("unsupported Docker resource")),
            };
            let name = string(request, "name")?;
            if name.is_empty()
                || name.len() > 512
                || name.starts_with('-')
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-:/@".contains(&c))
            {
                return Err(invalid("invalid Docker resource name"));
            }
            Ok(
                json!({"output":run("docker",vec![command.into(),"inspect".into(),name.into()]).await?}),
            )
        }
        "docker.inspect" | "docker.logs" | "docker.action" | "docker.top" => {
            let id = identifier(string(request, "container")?)?;
            let args = match op {
                "docker.inspect" => vec!["inspect".into(), id.into()],
                "docker.logs" => {
                    let tail = request["tail"].as_u64().unwrap_or(200);
                    if !(1..=5000).contains(&tail) {
                        return Err(invalid("log tail must be 1–5000"));
                    }
                    let mut args = vec!["logs".into(), "--tail".into(), tail.to_string()];
                    if request["timestamps"].as_bool().unwrap_or(true) {
                        args.push("--timestamps".into());
                    }
                    if let Some(since) = request["since"].as_str().filter(|s| !s.is_empty()) {
                        if !["1m", "5m", "15m", "1h", "24h"].contains(&since) {
                            return Err(invalid("unsupported log time range"));
                        }
                        args.extend(["--since".into(), since.into()]);
                    }
                    args.push(id.into());
                    args
                }
                "docker.top" => vec!["top".into(), id.into()],
                _ => {
                    let action = string(request, "action")?;
                    if !["start", "stop", "restart", "pause", "unpause"].contains(&action) {
                        return Err(invalid("unsupported Docker action"));
                    }
                    vec![action.into(), id.into()]
                }
            };
            let (stdout, stderr) = run_capture("docker", args).await?;
            let output = if op == "docker.logs" {
                let combined = format!("{stdout}{stderr}");
                let mut lines: Vec<_> = combined.lines().collect();
                // Docker prefixes both streams with RFC3339 timestamps. Restore
                // chronology after reading bounded stdout/stderr separately.
                if request["timestamps"].as_bool().unwrap_or(true)
                    && lines
                        .iter()
                        .all(|line| line.as_bytes().get(10) == Some(&b'T'))
                {
                    lines.sort_by_key(|line| line.split_whitespace().next().unwrap_or(""));
                    lines.join("\n")
                } else {
                    combined
                }
            } else {
                stdout
            };
            Ok(json!({"output":output}))
        }
        "compose.list" => {
            let text = run(
                "docker",
                vec![
                    "compose".into(),
                    "ls".into(),
                    "--all".into(),
                    "--format".into(),
                    "json".into(),
                ],
            )
            .await?;
            let projects: Value =
                serde_json::from_str(&text).map_err(|_| invalid("invalid Compose response"))?;
            Ok(json!({"projects":projects}))
        }
        "compose.action" => {
            let project = identifier(string(request, "project")?)?;
            // Resolve config files from Docker, rather than accepting arbitrary user paths/flags.
            let text = run(
                "docker",
                vec![
                    "compose".into(),
                    "ls".into(),
                    "--all".into(),
                    "--format".into(),
                    "json".into(),
                ],
            )
            .await?;
            let projects: Value =
                serde_json::from_str(&text).map_err(|_| invalid("invalid Compose response"))?;
            let row = projects
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["Name"].as_str() == Some(project))
                })
                .ok_or_else(|| invalid("Compose project no longer exists"))?;
            let config = row["ConfigFiles"]
                .as_str()
                .ok_or_else(|| invalid("project has no Compose configuration"))?;
            let action = string(request, "action")?;
            if !["start", "stop", "restart", "up"].contains(&action) {
                return Err(invalid("unsupported Compose action"));
            }
            let mut args = vec!["compose".into(), "--project-name".into(), project.into()];
            for file in config.split(',') {
                if !file.starts_with('/') || file.len() > 4096 {
                    return Err(invalid("invalid Compose configuration path"));
                }
                args.extend(["--file".into(), file.into()]);
            }
            args.push(action.into());
            if action == "up" {
                args.push("--detach".into());
            }
            if let Some(service) = request["service"].as_str().filter(|v| !v.is_empty()) {
                args.push(identifier(service)?.into());
            }
            Ok(json!({"output":run("docker",args).await?}))
        }
        _ => Err(invalid("unsupported machine operation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_history_is_bounded_and_counter_resets_do_not_spike() {
        let now = Instant::now();
        let before = ResourceCounters {
            at: now,
            total: 100,
            idle: 40,
            received: 1000,
            sent: 2000,
            memory: 10,
            swap: 0,
        };
        let next = ResourceCounters {
            at: now + Duration::from_secs(1),
            total: 200,
            idle: 60,
            received: 1500,
            sent: 100,
            memory: 20,
            swap: 5,
        };
        let point = resource_sample(&next, Some(&before), 1234);
        assert_eq!(point["cpu"], 80.0);
        assert_eq!(point["rx"], 500.0);
        assert_eq!(point["tx"], 0.0);
        assert!(resource_sample(&before, None, 1)["cpu"].is_null());
        let mut history = ResourceHistory {
            root: PathBuf::from("/proc"),
            samples: VecDeque::new(),
        };
        for index in 0..1000 {
            retain_sample(&mut history, json!({"time":index * 500}));
        }
        assert_eq!(history.samples.len(), HISTORY_LIMIT);
        assert_eq!(history.samples.front().unwrap()["time"], 199500);
        retain_sample(&mut history, json!({"time":1_000_000}));
        assert_eq!(history.samples.len(), 1);
    }
    #[tokio::test]
    async fn statistics_history_is_opt_in_and_available_before_a_panel_opens() {
        let files = FileManager::from_env().unwrap();
        assert!(
            aggregate_text(proc_root(&files).join("meminfo"), 1)
                .await
                .is_err()
        );
        start_history(&files);
        tokio::time::sleep(Duration::from_millis(650)).await;
        let plain = handle("system.stats", &json!({}), &files).await.unwrap();
        assert!(plain.get("history").is_none());
        assert!(history_response(&json!({"history":{"v":999}}), &files).is_none());
        let history = history_response(&json!({"history":{"v":1,"unknown":true}}), &files).unwrap();
        assert_eq!(history["v"], 1);
        let points = history["samples"].as_array().unwrap();
        assert!(points.len() >= 2);
        assert!(points.last().unwrap()["cpu"].as_f64().is_some());
        let last = points.last().unwrap()["time"].as_u64().unwrap();
        let delta = history_response(&json!({"history":{"v":1,"after":last}}), &files).unwrap();
        assert!(delta["samples"].as_array().unwrap().is_empty());
        assert!(history["now"].as_u64().unwrap() >= last);
    }
    #[test]
    fn validates_identifiers_and_shell_quoting() {
        for value in ["", "--all", "a;touch /tmp/a", "$(id)", "a\nb"] {
            assert!(identifier(value).is_err());
        }
        assert!(identifier("project-one_2.3").is_ok());
        assert_eq!(quote("a'b"), "'a'\\''b'");
    }
    #[tokio::test]
    async fn command_output_is_bounded_without_waiting_for_process_exit() {
        let mut reader = &b"12345"[..];
        let mut output = Vec::new();
        assert!(bounded_output(&mut reader, &mut output, 4).await.is_err());
        assert_eq!(output.len(), 5);
        let error = timeout(
            Duration::from_secs(3),
            run_capture(
                "head",
                vec!["-c".into(), "600000".into(), "/dev/zero".into()],
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.to_string().contains("output exceeds limit"));
    }
    #[test]
    fn parses_process_names_with_parentheses() {
        let input = "42 (a b) c)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22";
        let (name, state, ticks, start, rss) = parse_stat(input).unwrap();
        assert_eq!(name, "a b) c)");
        assert_eq!(state, 'S');
        assert_eq!(ticks, 23);
        assert_eq!(start, 19);
        assert_eq!(rss, 21);
    }
    #[tokio::test]
    async fn reads_real_statistics_and_rejects_unsafe_controls() {
        let files = FileManager::from_env().unwrap();
        let snapshot = handle("system.stats", &json!({}), &files).await.unwrap();
        assert!(snapshot["memory"]["total"].as_u64().unwrap() > 0);
        assert!(snapshot["cpu"]["count"].as_u64().unwrap() > 0);
        assert!(snapshot["processes"].as_array().is_some());
        assert!(
            snapshot["cpu"]["cores"]
                .as_array()
                .is_some_and(|cores| !cores.is_empty())
        );
        let process = snapshot["processes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|process| process["pid"].as_u64() == Some(std::process::id() as u64));
        if let Some(process) = process {
            let detail = handle(
                "system.process",
                &json!({"pid":process["pid"],"startTicks":process["startTicks"]}),
                &files,
            )
            .await
            .unwrap();
            assert!(detail["command"].as_str().unwrap().len() <= 4096);
            assert!(detail.get("environment").is_none());
            assert!(
                handle(
                    "system.process",
                    &json!({"pid":process["pid"],"startTicks":u64::MAX}),
                    &files
                )
                .await
                .is_err()
            );
        }
        assert!(
            handle(
                "system.signal",
                &json!({"pid":1,"startTicks":0,"signal":"KILL"}),
                &files
            )
            .await
            .is_err()
        );
        assert!(
            handle(
                "docker.action",
                &json!({"container":"--all","action":"stop"}),
                &files
            )
            .await
            .is_err()
        );
        assert!(
            handle(
                "docker.action",
                &json!({"container":"valid","action":"rm"}),
                &files
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn signals_only_the_owned_process_identity() {
        if env::var_os("EYA_HOST_PID").is_some() {
            return;
        }
        let files = FileManager::from_env().unwrap();
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let data = tokio::fs::read_to_string(format!("/proc/{pid}/stat"))
            .await
            .unwrap();
        let start = parse_stat(&data).unwrap().3;
        assert!(
            handle(
                "system.signal",
                &json!({"pid":pid,"startTicks":start+1,"signal":"TERM"}),
                &files
            )
            .await
            .is_err()
        );
        assert!(child.try_wait().unwrap().is_none());
        handle(
            "system.signal",
            &json!({"pid":pid,"startTicks":start,"signal":"TERM"}),
            &files,
        )
        .await
        .unwrap();
        timeout(Duration::from_secs(2), child.wait())
            .await
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn docker_read_only_integration() {
        if env::var("EYA_TEST_DOCKER").as_deref() != Ok("1") {
            return;
        }
        let files = FileManager::from_env().unwrap();
        assert!(handle("docker.list", &json!({}), &files).await.unwrap()["containers"].is_array());
        assert!(handle("compose.list", &json!({}), &files).await.unwrap()["projects"].is_array());
        for kind in ["images", "networks", "volumes"] {
            assert!(
                handle("docker.resources", &json!({"kind":kind}), &files)
                    .await
                    .unwrap()["items"]
                    .is_array()
            );
        }
    }
}
