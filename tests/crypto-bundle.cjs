const { build } = require('../client/node_modules/esbuild');
const full = require('../client/node_modules/sodium-javascript');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const result = await build({stdin:{contents:"export * from './client/sodium-browser.js';",resolveDir:path.resolve('.')},bundle:true,platform:'browser',format:'cjs',write:false});
  const module = {exports:{}}; new Function('module','exports',result.outputFiles[0].text)(module,module.exports); const slim = module.exports;
  const seed = Uint8Array.from({length:32},(_,index)=>index);
  const pk = new Uint8Array(32), sk = new Uint8Array(32), expectedPk = new Uint8Array(32), expectedSk = new Uint8Array(32);
  slim.crypto_kx_seed_keypair(pk,sk,seed); full.crypto_kx_seed_keypair(expectedPk,expectedSk,seed);
  assert.deepEqual(pk,expectedPk);assert.deepEqual(sk,expectedSk);
  const dh = new Uint8Array(32), expectedDh = new Uint8Array(32);
  slim.crypto_scalarmult(dh,sk,pk);full.crypto_scalarmult(expectedDh,expectedSk,expectedPk);assert.deepEqual(dh,expectedDh);
  for (const size of [0,1,63,64,255,65500]) {
    const input=Uint8Array.from({length:size},(_,index)=>index%251), ad=new Uint8Array([1,3,5]), nonce=new Uint8Array(12);
    const ciphertext=new Uint8Array(size+16), expected=new Uint8Array(size+16);
    slim.crypto_aead_chacha20poly1305_ietf_encrypt(ciphertext,input,ad,null,nonce,seed);full.crypto_aead_chacha20poly1305_ietf_encrypt(expected,input,ad,null,nonce,seed);assert.deepEqual(ciphertext,expected);
    const plain=new Uint8Array(size);slim.crypto_aead_chacha20poly1305_ietf_decrypt(plain,null,expected,ad,nonce,seed);assert.deepEqual(plain,input);
    ciphertext[ciphertext.length-1]^=1;assert.throws(()=>slim.crypto_aead_chacha20poly1305_ietf_decrypt(plain,null,ciphertext,ad,nonce,seed));
    const hash=new Uint8Array(32),expectedHash=new Uint8Array(32);slim.crypto_generichash(hash,input);full.crypto_generichash(expectedHash,input);assert.deepEqual(hash,expectedHash);
    slim.crypto_generichash_batch(hash,[input,seed]);full.crypto_generichash_batch(expectedHash,[input,seed]);assert.deepEqual(hash,expectedHash);
  }
  const cleared=seed.slice();slim.sodium_memzero(cleared);assert(cleared.every(value=>value===0));
  console.log('Slim sodium matches the full pinned provider: seeded keys, X25519, BLAKE2b/batch, ChaCha20-Poly1305 boundaries and tamper rejection');
})().catch(error=>{console.error(error);process.exit(1);});
