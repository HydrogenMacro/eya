import { inflateRawBlock } from './terminal-codec.js';

// Negotiated, lossless RGBA screen updates. Full PNG/JPEG frames never become
// references: only pixels reconstructed from this format can be an XOR base.
export const MAX_BROWSER_TILE_PIXELS = 4 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024, MAX_TILES = 1024;
const invalid = () => { throw Error('Invalid remote browser tile update.'); };

export function browserTilesSupported() {
  try {
    return typeof document !== 'undefined' && typeof ImageData === 'function' && !!document.createElement('canvas').getContext('2d');
  } catch { return false; }
}

export function validateBrowserTileMetadata(meta) {
  if (!meta || meta.format !== 'rgba-tiles-v1' ||
      !Number.isInteger(meta.seq) || meta.seq < 1 || meta.seq > 0xffffffff ||
      !Number.isInteger(meta.base) || meta.base < 0 || meta.base > 0xffffffff || meta.base === meta.seq ||
      !Number.isInteger(meta.pixelWidth) || meta.pixelWidth < 1 || meta.pixelWidth > 8192 ||
      !Number.isInteger(meta.pixelHeight) || meta.pixelHeight < 1 || meta.pixelHeight > 8192 ||
      meta.pixelWidth * meta.pixelHeight > MAX_BROWSER_TILE_PIXELS ||
      !Number.isInteger(meta.width) || meta.width < 1 || meta.width > 8192 ||
      !Number.isInteger(meta.height) || meta.height < 1 || meta.height > 8192 ||
      !Number.isInteger(meta.tiles) || meta.tiles < 0 || meta.tiles > MAX_TILES || (!meta.base && !meta.tiles) ||
      typeof meta.tabId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(meta.tabId)) invalid();
}

export function createBrowserTileDecoder() {
  let reference = null, generation = 0, decoding = null;
  return {
    reset() {
      reference = null; generation++;
      decoding?.abort(Error('Remote browser tile reference reset.')); decoding = null;
    },
    async decode(bytes, meta) {
      validateBrowserTileMetadata(meta);
      if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > MAX_BYTES || decoding) invalid();
      const version = generation, controller = new AbortController(); decoding = controller;
      const timer = setTimeout(() => controller.abort(Error('Remote browser tile decoding timed out.')), 5000);
      try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0) !== 0x45595431) invalid(); // EYT1
        const edge = view.getUint16(4), count = view.getUint16(6);
        if (![64, 128].includes(edge) || count !== meta.tiles) invalid();
        const columns = Math.ceil(meta.pixelWidth / edge), rows = Math.ceil(meta.pixelHeight / edge), total = columns * rows;
        if (total > MAX_TILES || count > total || (!meta.base && count !== total)) invalid();
        if (meta.base && (!reference || reference.seq !== meta.base || reference.width !== meta.pixelWidth || reference.height !== meta.pixelHeight || reference.tabId !== meta.tabId)) throw Error('Remote browser tile reference is unavailable.');
        await Promise.resolve();
        if (version !== generation || controller.signal.aborted) invalid();
        const pixels = meta.base ? reference.pixels.slice() : new Uint8Array(meta.pixelWidth * meta.pixelHeight * 4);
        const seen = new Uint8Array(total);
        let offset = 8;
        for (let tile = 0; tile < count; tile++) {
          if (offset + 7 > bytes.length) invalid();
          const index = view.getUint16(offset), mode = bytes[offset + 2], length = view.getUint32(offset + 3); offset += 7;
          if (index >= total || seen[index] || mode > 1 || (!meta.base && mode) || !length || length > bytes.length - offset) invalid();
          seen[index] = 1;
          const x = (index % columns) * edge, y = Math.floor(index / columns) * edge;
          const width = Math.min(edge, meta.pixelWidth - x), height = Math.min(edge, meta.pixelHeight - y);
          if (length > width * height * 4 + 128) invalid();
          const decoded = inflateRawBlock(bytes.subarray(offset, offset + length), width * height * 4, 65536); offset += length;
          for (let row = 0; row < height; row++) {
            const start = ((y + row) * meta.pixelWidth + x) * 4, source = row * width * 4;
            if (!mode) pixels.set(decoded.subarray(source, source + width * 4), start);
            else for (let column = 0; column < width * 4; column++) pixels[start + column] ^= decoded[source + column];
          }
          // Large keyframes yield between bounded batches so input, tab resets
          // and the decode deadline can run before an atomic presentation.
          if ((tile + 1) % 16 === 0 && tile + 1 < count) {
            await new Promise(resolve => {
              if (typeof MessageChannel !== 'function') { setTimeout(resolve, 0); return; }
              const channel = new MessageChannel();
              channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
              channel.port2.postMessage(null);
            });
            if (version !== generation || controller.signal.aborted) invalid();
          }
        }
        if (offset !== bytes.length || version !== generation || controller.signal.aborted) invalid();
        return { pixels, width: meta.pixelWidth, height: meta.pixelHeight, seq: meta.seq, tabId: meta.tabId, base: meta.base, generation: version };
      } finally {
        clearTimeout(timer);
        if (decoding === controller) decoding = null;
      }
    },
    commit(frame) {
      if (frame.generation !== generation || (frame.base && reference?.seq !== frame.base)) invalid();
      reference = frame;
    },
  };
}
