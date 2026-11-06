import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const noise = new Noise('NNpsk0', true, null, {psk:Uint8Array.from({length:32},(_,index)=>index)});
noise.initialise(encoder.encode('eya-terminal-v1'));
const socket = new WebSocket('ws://127.0.0.1:18765/ws'); socket.binaryType='arraybuffer';
const pending = new Map(), chunks = new Map();
let inbound,outbound,nextId=0,terminal='',markerResolve;
const marker = new Promise(resolve=>{markerResolve=resolve;});
function send(value){socket.send(outbound.encrypt(value));}
let readyResolve,readyReject;
const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
socket.onopen=()=>socket.send(noise.send());
socket.onerror=readyReject;
socket.onmessage=event=>{
  try{
    const wire=new Uint8Array(event.data);
    if(!noise.complete){noise.recv(wire);outbound=new Cipher(noise.tx);inbound=new Cipher(noise.rx);const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),value=>value.toString(16).padStart(2,'0')).join('');send(encoder.encode('eya-ready-v4:'+JSON.stringify({token,output:0,create:true})));return;}
    const data=inbound.decrypt(wire);
    if(data[0]===7){const state=JSON.parse(decoder.decode(data.subarray(1)));if(state.state==='ready')readyResolve();else if(state.state==='ended')socket.close();else throw Error(state.message||state.state);}
    else if(data[0]===8){
      const offset=new DataView(data.buffer,data.byteOffset+1,8).getBigUint64(0);const bytes=data.subarray(9);
      const ack=new Uint8Array(9);ack[0]=2;new DataView(ack.buffer).setBigUint64(1,offset+BigInt(bytes.length));send(ack);
      terminal+=decoder.decode(bytes);if(terminal.includes('MACHINE_IO_OK'))markerResolve();
    }else if(data[0]===4)deliver(JSON.parse(decoder.decode(data.subarray(1))));
    else if(data[0]===6){const id=new DataView(data.buffer,data.byteOffset+1,4).getUint32(0);const list=chunks.get(id)||[];list.push(data.slice(6));chunks.set(id,list);if(data[5]){chunks.delete(id);const buffer=new Uint8Array(list.reduce((sum,chunk)=>sum+chunk.length,0));let offset=0;for(const chunk of list){buffer.set(chunk,offset);offset+=chunk.length;}deliver(JSON.parse(decoder.decode(buffer)));}}
  }catch(error){readyReject(error);console.error(error);process.exit(1);}
};
function deliver(value){const job=pending.get(value.id);if(!job)return;pending.delete(value.id);value.ok?job.resolve(value):job.reject(Error(value.error));}
function request(op,args={}){const id=++nextId;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});const bytes=encoder.encode(JSON.stringify({id,op,...args}));const message=new Uint8Array(1+bytes.length);message[0]=4;message.set(bytes,1);send(message);});}
const deadline=setTimeout(()=>{console.error('Machine protocol test timed out');process.exit(1);},30000);
(async()=>{
  await ready;
  const stats=await request('system.stats');
  if(!(stats.memory.total>0)||!Array.isArray(stats.processes)||!(stats.cpu.count>0))throw Error('Invalid machine statistics');
  let docker;
  if(process.env.EYA_TEST_DOCKER==='1'){
    const start=performance.now();const pendingDocker=request('docker.list');
    const command="printf '"+[...'MACHINE_IO_OK\n'].map(char=>'\\'+char.charCodeAt(0).toString(8).padStart(3,'0')).join('')+"'\n";
    const text=encoder.encode(command),input=new Uint8Array(9+text.length);input[0]=0;new DataView(input.buffer).setBigUint64(1,0n);input.set(text,9);send(input);
    await Promise.race([marker,new Promise((_,reject)=>setTimeout(()=>reject(Error('Docker query blocked terminal IO')),1500))]);
    docker=await pendingDocker;
    const compose=await request('compose.list');
    if(!Array.isArray(docker.containers)||!Array.isArray(compose.projects))throw Error('Invalid Docker/Compose data');
    console.log(`Terminal remained responsive during Docker query (${Math.round(performance.now()-start)}ms total Docker round trip)`);
  }
  await request('docker.action',{container:'--all',action:'stop'}).then(()=>{throw Error('Unsafe Docker arguments accepted');},()=>{});
  await request('system.signal',{pid:1,startTicks:0,signal:'KILL'}).then(()=>{throw Error('PID 1 accepted');},()=>{});
  send(Uint8Array.of(10));clearTimeout(deadline);
  console.log('Encrypted machine stats, Docker/Compose read-only data, responsive terminal IO, and unsafe-control rejection passed');
})().catch(error=>{console.error(error);process.exit(1);});
