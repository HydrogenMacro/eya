// Codec CPU and actual Linux browser/server high-water RSS. Build client/server
// first; run NODE_PATH=client/node_modules EYA_RESOURCE_REPORT=/tmp/resources.json
// node tests/terminal-network-resources.cjs. Rust dependencies are used offline.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { deflateRawSync } = require('node:zlib');
const { build } = require('esbuild');
const Module = require('node:module');
const { fixture } = require('./continuity-fixture.cjs');
const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function memory(pid) {
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  return { rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0), highWaterKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] || 0) };
}
(async () => {
  const f = await fixture();
  const report = { platform: `${process.platform}/${process.arch}`, node: process.version, codecCpu: [], browser: [], sourceHashes: {} };
  try {
    const resume = await fs.readFile('eya-server/src/resume.rs', 'utf8');
    for (const name of ['eya-server/src/resume.rs', 'client/terminal-codec.js', 'client.html', 'tests/terminal-network-resources.cjs']) report.sourceHashes[name] = hash(await fs.readFile(name));
    const begin = resume.indexOf('fn output_frame('), end = resume.indexOf('\n}\n', begin) + 2;
    assert.ok(begin > 0 && end > begin);
    const constant = resume.match(/^const OUTPUT_CHUNK: usize = 8192;$/m)?.[0]; assert.ok(constant);
    const cargo = path.join(f.root, 'encoder'); await fs.mkdir(path.join(cargo, 'src'), { recursive: true });
    await fs.writeFile(path.join(cargo, 'Cargo.toml'), '[package]\nname="eya-terminal-encoder-probe"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nflate2={version="=1.1.11",default-features=false,features=["rust_backend"]}\nlibc="=0.2.191"\n');
    // Compile the actual production function, not a separately rewritten codec.
    const program = `use std::io::{self,Write}; use flate2::{Compression,write::DeflateEncoder};\n${constant}\n${resume.slice(begin,end)}\nfn cpu()->u128 {let mut t=libc::timespec{tv_sec:0,tv_nsec:0}; assert_eq!(unsafe{libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID,&mut t)},0);t.tv_sec as u128*1_000_000_000+t.tv_nsec as u128}\nfn main(){let args:Vec<_>=std::env::args().collect();let data=std::fs::read(&args[1]).unwrap();for compression in [false,true] {for _ in 0..100 {std::hint::black_box(output_frame(0,&data,compression).unwrap());}let cpu_start=cpu();let wall=std::time::Instant::now();let mut len=0;let mut kind=0;for _ in 0..2000 {let frame=output_frame(0,std::hint::black_box(&data),compression).unwrap();len=frame.len();kind=frame[0];std::hint::black_box(frame);}println!("{},{},{},{},{},{}",compression,kind,len,2000,(cpu()-cpu_start)as f64/1000.0,wall.elapsed().as_secs_f64()*1e6);}}`;
    await fs.writeFile(path.join(cargo, 'src/main.rs'), program);
    const source = (await fs.readFile('eya-server/src/system.rs')).subarray(0,8192);
    const logs = Buffer.from(Array.from({ length: 160 }, (_, i) => `\x1b[32mINFO request=${i} terminal retained output cpu=12% mem=256MiB\x1b[0m\r\n`).join('')).subarray(0,8192);
    const entropy = Buffer.concat(Array.from({ length: 256 }, (_, i) => createHash('sha256').update(`entropy ${i}`).digest()));
    const env = { ...process.env }; delete env.EYA_KEY;
    await execute('cargo', ['build','--offline','--release','--manifest-path',path.join(cargo,'Cargo.toml')], { env, timeout: 120000 });
    const built = await build({ stdin: { contents: "export {inflateTerminalBlock} from './client/terminal-codec.js';", resolveDir: process.cwd() }, bundle:true, platform:'node',format:'cjs',write:false });
    const module = new Module('terminal-codec-resource-probe'); module._compile(built.outputFiles[0].text, 'terminal-codec-resource-probe.cjs');
    for (const [name, bytes] of [['source',source],['logs',logs],['entropy',entropy]]) {
      const filename = path.join(f.root, `${name}.bin`); await fs.writeFile(filename,bytes);
      const encoded = await execute(path.join(cargo,'target/release/eya-terminal-encoder-probe'), [filename], { env, timeout: 30000 });
      const encode = encoded.stdout.trim().split('\n').map(line => {const [on,opcode,frameBytes,iterations,cpuUs,wallUs]=line.split(',');return {compression:on==='true',opcode:Number(opcode),frameBytes:Number(frameBytes),iterations:Number(iterations),cpuMicrosecondsPerBlock:Number(cpuUs)/Number(iterations),wallMicrosecondsPerBlock:Number(wallUs)/Number(iterations)};});
      const compressed = deflateRawSync(bytes,{level:1}); let decode = null;
      if (compressed.length <= 8192) {
        assert.deepEqual(Buffer.from(module.exports.inflateTerminalBlock(compressed,bytes.length)),bytes);
        for(let n=0;n<100;n++)module.exports.inflateTerminalBlock(compressed,bytes.length);
        const start=process.cpuUsage(), wall=performance.now();
        for(let n=0;n<2000;n++)module.exports.inflateTerminalBlock(compressed,bytes.length);
        const elapsed=process.cpuUsage(start); decode={iterations:2000,cpuMicrosecondsPerBlock:(elapsed.user+elapsed.system)/2000,wallMicrosecondsPerBlock:(performance.now()-wall)*1000/2000};
      }
      report.codecCpu.push({name,bytes:bytes.length,sha256:hash(bytes),encode,decode});
    }
    const output = Buffer.from(Array.from({length:12000},(_,i)=>`\x1b[32mresource ${i} 界🙂 retained terminal output\x1b[0m\n`).join('')+'EYA_RESOURCE_DONE\n');
    const filename=path.join(f.files,'resource-output.txt'); await fs.writeFile(filename,output);
    for(const compression of [false,true]) {
      const page=await f.client({webgl:false,terminalCompression:compression,viewport:{width:375,height:740}});
      const cdp=await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
      const id=await page.evaluate(()=>EyaPanels.create('terminal')); await page.waitForFunction(id=>EyaPanels.call(id,'getState').connected,id);
      const beforeServer=await memory(f.pid), browserCdp=await page.context().browser().newBrowserCDPSession();
      await page.evaluate(({id,script})=>EyaPanels.call(id,'sendInput',script),{id,script:`stty -echo; cat -- ${quote(filename)}\r`});
      await page.waitForFunction(()=>document.querySelector('.instance-terminal .xterm-screen').textContent.includes('EYA_RESOURCE_DONE'),null,{timeout:90000});
      await page.waitForFunction(id=>EyaPanels.call(id,'getState').network.outputBacklog===0,id);
      const processInfo=await browserCdp.send('SystemInfo.getProcessInfo');
      const renderers=[];for(const entry of processInfo.processInfo.filter(entry=>entry.type==='renderer')){try{renderers.push(await memory(entry.id));}catch{}}
      assert.ok(renderers.length && renderers.every(entry=>entry.highWaterKiB>0));
      const network=await page.evaluate(id=>EyaPanels.call(id,'getState').network,id);
      assert.ok(network.maxOutputBacklog<=320*1024);assert.ok(network.decodedOutputBytes>=output.length);
      report.browser.push({compression,cpuSlowdown:4,renderer:'DOM',outputBytes:output.length,rendererHighWaterKiB:Math.max(...renderers.map(entry=>entry.highWaterKiB)),rendererRssEndKiB:Math.max(...renderers.map(entry=>entry.rssKiB)),serverBefore:beforeServer,serverAfter:await memory(f.pid),network});
      await browserCdp.detach(); await page.evaluate(id=>EyaPanels.close(id),id);await page.context().close();
    }
    assert.deepEqual(f.errors,[]);
    report.notes=['Encoder CPU: actual production output_frame function extracted verbatim and compiled release with identical flate2/Rust backend; CLOCK_THREAD_CPUTIME_ID excludes compilation/I/O.','Decoder CPU: actual JS module in Node V8, process CPU plus wall duration; real browser timing is also recorded under4x CPU slowdown.','Linux VmHWM is actual process-lifetime RSS peak, including engine/DOM/startup, not only JS heap. Renderer values take the maximum of active renderer processes.','Local loopback throughput resource stress, not another WAN latency result or physical battery test.'];
    if(process.env.EYA_RESOURCE_REPORT)await fs.writeFile(process.env.EYA_RESOURCE_REPORT,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report)); console.log('Terminal codec CPU and browser/server high-water resource probe passed');
  } finally {await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
