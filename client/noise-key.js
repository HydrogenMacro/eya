import { crypto_hash_sha256 } from 'sodium-javascript/crypto_hash_sha256.js';

const encoder = new TextEncoder();

export function deriveKey(secret) {
  if (/^[0-9a-f]{64}$/i.test(secret)) return Uint8Array.from(secret.match(/../g), hex => parseInt(hex, 16));
  // Opaque data URLs and plain HTTP do not expose Web Crypto's digest API.
  const password = encoder.encode(secret);
  const key = new Uint8Array(32);
  crypto_hash_sha256(key, password, password.length);
  return key;
}
