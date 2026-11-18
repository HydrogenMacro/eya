// A reproducible payload/framing estimate, not a network-latency benchmark.
// Run: node tests/terminal-compression-benchmark.cjs
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'eya-server/src/system.rs'));
const logs = Buffer.from(Array.from({ length: 2048 }, (_, i) =>
  `2026-11-08T12:${String(i % 60).padStart(2, '0')}:00Z INFO request=${i} route=/workspace status=200 elapsed=${i % 37}ms\r\n`).join(''));
const tui = Buffer.from(Array.from({ length: 64 }, (_, frame) =>
  '\x1b[H' + Array.from({ length: 24 }, (_, row) =>
    `\x1b[${row + 1};1H\x1b[${row % 2 ? 32 : 36}m${String(row).padStart(3)} process-${row} cpu=${(row * 7 + frame) % 100}% mem=${(row * 31) % 4096}MiB\x1b[0m\x1b[K`).join('')).join(''));
const entropy = Buffer.concat(Array.from({ length: 2048 }, (_, i) =>
  createHash('sha256').update(`fixed benchmark entropy ${i}`).digest()));

// Server -> browser: no masking. Noise adds a 16-byte AEAD tag. Existing
// terminal framing is opcode + u64 offset (9 bytes). Proposed compressed
// framing adds u32 decoded length (13 bytes). Excludes TCP/IP/TLS and ACKs.
function wire(payloadBytes, terminalHeader) {
  const encryptedBytes = payloadBytes + terminalHeader + 16;
  return encryptedBytes + (encryptedBytes < 126 ? 2 : encryptedBytes <= 65535 ? 4 : 10);
}
function measure(name, bytes, chunkSize) {
  let rawPayload = 0, compressedPayload = 0, rawWire = 0, selectedWire = 0, chunks = 0, selected = 0;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const chunk = bytes.subarray(start, start + chunkSize);
    const compressed = deflateRawSync(chunk, { level: 1 });
    const raw = wire(chunk.length, 9), zipped = wire(compressed.length, 13);
    rawPayload += chunk.length; compressedPayload += compressed.length; rawWire += raw;
    const use = chunk.length >= 256 && raw - zipped >= 16;
    selectedWire += use ? zipped : raw; chunks++; if (use) selected++;
  }
  return { name, chunkSize, bytes: rawPayload, chunks, selected,
    compressedPayload, rawWire, selectedWire,
    payloadReduction: `${(100 * (1 - compressedPayload / rawPayload)).toFixed(1)}%`,
    wireReduction: `${(100 * (1 - selectedWire / rawWire)).toFixed(1)}%` };
}
console.log(JSON.stringify({ node: process.version, zlib: process.versions.zlib,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  results: [
    measure('single key echo', Buffer.from('x'), 1),
    measure('short prompt', Buffer.from('\x1b[32meya@host\x1b[0m:~/project$ '), 256),
    ...[1024, 8192].flatMap(size => [
      measure('actual Rust source', source, size), measure('synthetic varying logs', logs, size),
      measure('synthetic full-screen redraws', tui, size), measure('deterministic high entropy', entropy, size),
    ]),
  ],
}, null, 2));
