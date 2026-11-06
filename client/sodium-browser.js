// Keep the pinned sodium implementations; expose only Noise's primitives.
// sodium-universal's CommonJS forwarding index otherwise pulls every algorithm in.
export { sodium_memzero } from 'sodium-javascript/memory.js';
export { crypto_kx_SEEDBYTES, crypto_kx_keypair, crypto_kx_seed_keypair } from 'sodium-javascript/crypto_kx.js';
export { crypto_scalarmult_BYTES, crypto_scalarmult_SCALARBYTES, crypto_scalarmult, crypto_scalarmult_base } from 'sodium-javascript/crypto_scalarmult.js';
export { crypto_generichash, crypto_generichash_batch } from 'sodium-javascript/crypto_generichash.js';
export { crypto_aead_chacha20poly1305_ietf_NPUBBYTES, crypto_aead_chacha20poly1305_ietf_ABYTES, crypto_aead_chacha20poly1305_ietf_encrypt, crypto_aead_chacha20poly1305_ietf_decrypt } from 'sodium-javascript/crypto_aead.js';
