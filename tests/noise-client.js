import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
const encoder = new TextEncoder();
const mode = process.argv[2] || 'valid';
const key = Uint8Array.from({ length: 32 }, (_, i) => mode === 'bad-key' ? i + 1 : i);
let passed = false;
let handshakeComplete = false;
const noise = new Noise('NNpsk0', true, null, { psk: key });
noise.initialise(encoder.encode('eya-terminal-v1'));
const ws = new WebSocket('ws://127.0.0.1:18765/ws');
ws.binaryType = 'arraybuffer';
let send, receive, output = '';
const timer = setTimeout(() => { console.error('Timed out:', output); process.exit(1); }, 5000);
ws.onopen = () => ws.send(noise.send());
ws.onmessage = event => {
  try {
    if (!noise.complete) {
      noise.recv(new Uint8Array(event.data));
      handshakeComplete = true;
      send = new Cipher(noise.tx); receive = new Cipher(noise.rx);
      ws.send(send.encrypt(encoder.encode('eya-ready')));
      ws.send(send.encrypt(Uint8Array.of(1, 0, 100, 0, 30)));
      const command = send.encrypt(Uint8Array.from([0, ...encoder.encode('stty size; printf "\\nEYA_TEST_OK\\n"\n')]));
      if (mode === 'tamper') command[0] ^= 1;
      ws.send(command);
    } else {
      output += new TextDecoder().decode(receive.decrypt(new Uint8Array(event.data)));
      if (output.includes('30 100') && output.includes('EYA_TEST_OK')) { passed = true; clearTimeout(timer); console.log('Noise handshake, PTY input/output and resize passed'); ws.close(); process.exit(0); }
    }
  } catch (e) { console.error(e); process.exit(1); }
};
ws.onclose = () => { if ((mode === 'bad-key' && !handshakeComplete) || (mode === 'tamper' && handshakeComplete)) { clearTimeout(timer); console.log(mode + ' rejected'); process.exit(0); } if (!passed) process.exit(1); };
ws.onerror = e => { if (mode === 'valid' && !passed) { console.error('WebSocket error', e); process.exit(1); } };
