const assert=require('node:assert/strict');
const Noise=require('noise-handshake'),Cipher=require('noise-handshake/cipher');
const {chromium}=require('playwright');
const {fixture,KEY}=require('./continuity-fixture.cjs');
(async()=>{
 const f=await fixture({env:{EYA_BROWSER_CHROMIUM:process.env.EYA_BROWSER_EXECUTABLE||chromium.executablePath()}});let socket;
 try{
  const encoder=new TextEncoder(),decoder=new TextDecoder(),noise=new Noise('NNpsk0',true,null,{psk:Buffer.from(KEY,'hex')});noise.initialise(encoder.encode('eya-browser-render-v1'));
  socket=new WebSocket(f.url.replace('/ws','/browser-render-ws'));socket.binaryType='arraybuffer';
  let tx,rx,stage=0,frame;const events=[],frames=[],errors=[];
  const send=bytes=>socket.send(tx.encrypt(bytes));
  const command=(tag,value)=>send(Uint8Array.of(tag,...encoder.encode(JSON.stringify(value))));
  socket.onopen=()=>socket.send(noise.send());
  socket.onmessage=({data})=>{
   try{
    if(stage===0){noise.recv(new Uint8Array(data));tx=new Cipher(noise.tx);rx=new Cipher(noise.rx);stage=1;socket.send(tx.encrypt(encoder.encode('eya-browser-render-ready-v1')));return;}
    const message=rx.decrypt(new Uint8Array(data));
    if(stage===1){assert.equal(decoder.decode(message),'eya-browser-render-ready-v1');stage=2;send(Uint8Array.of(1));return;}
    if([129,133,134].includes(message[0]))events.push(JSON.parse(decoder.decode(message.subarray(1))));
    if(message[0]===130){frame=JSON.parse(decoder.decode(message.subarray(1)));frames.push(frame);}
    if(message[0]===131&&new DataView(message.buffer,message.byteOffset).getUint16(5)===frame.chunks-1){const ack=new Uint8Array(5);ack[0]=5;new DataView(ack.buffer).setUint32(1,frame.seq);send(ack);}
   }catch(error){errors.push(error);}
  };
  const until=async find=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(errors.length)throw errors[0];const result=find();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw Error('Missing compatibility event '+JSON.stringify(events.slice(-5)));};
  await until(()=>events.find(e=>e.type==='ready'));command(27,{tabId:'old'});await until(()=>events.find(e=>e.type==='tab-activated'));
  command(3,{tabId:'old',width:800,height:600,unknown:true,stream:{format:'png'}});
  command(7,{id:1,tabId:'old',expression:"document.body.textContent='Old client';true"});
  await until(()=>frames.find(f=>f.width===800));assert.equal(frames.at(-1).format,'jpeg','No capability offer must preserve baseline JPEG');
  command(7,{id:70,tabId:'old',expression:"__eyaCursor('text');true"});await until(()=>events.find(e=>e.id===70));
  assert.equal(events.some(e=>e.type==='cursor'),false,'Unnegotiated clients never receive cursor hints');
  let before=events.length;
  command(3,{tabId:'old',width:800,height:600,capabilities:['future-v9'],stream:{format:'png',future:true}});
  const unknown=await until(()=>events.slice(before).find(e=>e.type==='stream-settings'));assert.deepEqual(unknown.capabilities,[]);assert.equal(unknown.stream.format,'jpeg');
  command(38,{tabId:'old',x:4,y:4});await until(()=>events.find(e=>/not negotiated/.test(e.message||'')));
  before=events.length;
  command(3,{tabId:'old',width:800,height:600,capabilities:['future-v9','stream-settings-v1'],stream:{format:'png',maxWidth:640,maxHeight:480,unknown:true}});
  const selected=await until(()=>events.slice(before).find(e=>e.type==='stream-settings'));assert.deepEqual(selected.capabilities,['stream-settings-v1']);
  command(7,{id:2,tabId:'old',expression:"document.body.textContent='New encoding';true"});await until(()=>frames.find(f=>f.format==='png'));
  before=events.length;command(3,{tabId:'old',width:800,height:600,capabilities:['stream-settings-v1'],stream:{format:'av1'}});
  await until(()=>events.slice(before).find(e=>/Invalid stream settings/.test(e.message||'')));
  before=events.length;command(3,{tabId:'old',width:800,height:600,capabilities:['cursor-v1','future-v9']});
  assert.deepEqual((await until(()=>events.slice(before).find(e=>e.type==='stream-settings'))).capabilities,['cursor-v1']);
  command(7,{id:71,tabId:'old',expression:"__eyaCursor('text');true"});
  assert.equal((await until(()=>events.slice(before).find(e=>e.type==='cursor'))).cursor,'text');
  before=events.length;command(7,{id:72,tabId:'old',expression:"__eyaCursor('url(https://bad.test/cursor),pointer');__eyaCursor('future-cursor');true"});await until(()=>events.slice(before).find(e=>e.id===72));
  assert.equal(events.slice(before).some(e=>e.type==='cursor'),false,'Image URLs and unknown cursor keywords are rejected');
  assert.deepEqual(errors,[]);send(Uint8Array.of(6));
  console.log('Browser old-client JPEG baseline, absent/unknown capabilities and fields, offered-only PNG selection and unsupported/invalid operations passed.');
 }finally{socket?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
