# Rebuild the client and restart this checkout's server in the background.
default: dev

# Rebuild the self-contained browser client.
build:
    node client/build.mjs

# Stop this checkout's native server and any cargo run still starting it.
stop:
    #!/usr/bin/env bash
    set -euo pipefail
    project_root='{{justfile_directory()}}'
    for pid in $(pgrep -u "$(id -u)" -x eya-server || true); do
        executable=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
        executable=${executable% (deleted)}
        case "$executable" in
            "$project_root"/eya-server/target/*/eya-server)
                kill "$pid" 2>/dev/null || true
                ;;
        esac
    done
    for pid in $(pgrep -u "$(id -u)" -x cargo || true); do
        process_cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        if [[ "$process_cwd" == "$project_root/eya-server" && -r "/proc/$pid/cmdline" ]]; then
            mapfile -d '' -t arguments < "/proc/$pid/cmdline" || continue
            if [[ "${arguments[1]:-}" == run ]]; then
                kill "$pid" 2>/dev/null || true
            fi
        fi
    done
    # Give terminated servers time to release their listening sockets.
    for attempt in {1..50}; do
        remaining=false
        for pid in $(pgrep -u "$(id -u)" -x eya-server || true); do
            executable=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
            executable=${executable% (deleted)}
            case "$executable" in
                "$project_root"/eya-server/target/*/eya-server) remaining=true ;;
            esac
        done
        if [[ "$remaining" == false ]]; then exit 0; fi
        sleep 0.1
    done
    echo 'Previous server did not stop within 5 seconds.' >&2
    exit 1

# Run from eya-server so its optional .env is loaded. Logs stay under target/.
dev: build stop
    #!/usr/bin/env bash
    set -euo pipefail
    cd '{{justfile_directory()}}/eya-server'
    mkdir -p target
    log="$PWD/target/dev-server.log"
    : > "$log"
    setsid nohup cargo run --locked >> "$log" 2>&1 < /dev/null &
    server_pid=$!
    echo "$server_pid" > target/dev-server.pid
    echo "Starting background server (PID $server_pid); log: $log"
    for attempt in {1..1200}; do
        if grep -q '^Eya listening on ' "$log"; then
            grep '^Eya listening on ' "$log"
            exit 0
        fi
        if ! kill -0 "$server_pid" 2>/dev/null; then
            echo "Server startup failed; see $log" >&2
            exit 1
        fi
        sleep 0.1
    done
    echo "Server is still starting after 120 seconds; see $log" >&2
    exit 1
