// Independent raw-DEFLATE terminal blocks. All allocations and writes are
// bounded before decoding: a peer cannot turn a tiny frame into a large buffer.
export const MAX_TERMINAL_BLOCK = 8192;
const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const distanceExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const codeOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const invalid = () => { throw Error('Invalid compressed terminal output'); };

function tree(lengths, allowEmpty = false, complete = false) {
  const counts = new Uint16Array(16), first = new Uint16Array(16), offsets = new Uint16Array(16);
  let symbols = 0, max = 0;
  for (const length of lengths) {
    if (length > 15) invalid();
    if (length) { counts[length]++; symbols++; max = Math.max(max, length); }
  }
  if (!symbols) { if (allowEmpty) return null; invalid(); }
  let remaining = 1, code = 0, offset = 0;
  for (let bits = 1; bits <= 15; bits++) {
    remaining = remaining * 2 - counts[bits];
    if (remaining < 0) invalid();
    code = (code + counts[bits - 1]) * 2;
    first[bits] = code; offsets[bits] = offset; offset += counts[bits];
  }
  // DEFLATE permits a single one-bit literal/distance code, and an unused
  // empty distance tree. Other incomplete or oversubscribed trees are invalid.
  if (remaining && (complete || symbols !== 1 || max !== 1)) invalid();
  const values = new Uint16Array(symbols), next = offsets.slice();
  lengths.forEach((length, symbol) => { if (length) values[next[length]++] = symbol; });
  return { counts, first, offsets, values, max };
}

const fixedLengths = Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
const fixedLiteral = tree(fixedLengths), fixedDistance = tree(Array(32).fill(5));

export function inflateTerminalBlock(data, decodedLength) {
  // Preserve the deployed terminal bounds exactly, including encoded bytes.
  if (!(data instanceof Uint8Array) || data.length > MAX_TERMINAL_BLOCK) invalid();
  return inflateRawBlock(data, decodedLength, MAX_TERMINAL_BLOCK);
}

// Shared bounded core. Browser tiles allow at most one 128×128 RGBA tile;
// terminal callers retain the narrower 8 KiB contract above. A fixed output
// buffer, exact decoded length and consumed-input check reject expansion bombs.
export function inflateRawBlock(data, decodedLength, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536 || !(data instanceof Uint8Array) || !data.length || data.length > maxBytes + 128 || !Number.isInteger(decodedLength) || decodedLength < 1 || decodedLength > maxBytes) invalid();
  const output = new Uint8Array(decodedLength);
  let position = 0, written = 0;
  function bits(count) {
    if (position + count > data.length * 8) invalid();
    let value = 0;
    for (let i = 0; i < count; i++, position++) value |= ((data[position >> 3] >> (position & 7)) & 1) << i;
    return value;
  }
  function symbol(table) {
    if (!table) invalid();
    let code = 0;
    for (let length = 1; length <= table.max; length++) {
      code = code * 2 + bits(1);
      const index = code - table.first[length];
      if (index >= 0 && index < table.counts[length]) return table.values[table.offsets[length] + index];
    }
    invalid();
  }
  let final;
  do {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      position = Math.ceil(position / 8) * 8;
      const length = bits(16), inverse = bits(16);
      if ((length ^ inverse) !== 65535 || written + length > output.length || position + length * 8 > data.length * 8) invalid();
      output.set(data.subarray(position / 8, position / 8 + length), written);
      written += length; position += length * 8;
      continue;
    }
    if (type === 3) invalid();
    let literal = fixedLiteral, distance = fixedDistance;
    if (type === 2) {
      const literals = bits(5) + 257, distances = bits(5) + 1, codeCount = bits(4) + 4;
      if (literals > 286) invalid();
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < codeCount; i++) codeLengths[codeOrder[i]] = bits(3);
      const codes = tree(codeLengths, false, true), lengths = new Uint8Array(literals + distances);
      for (let i = 0; i < lengths.length;) {
        const value = symbol(codes);
        if (value < 16) { lengths[i++] = value; continue; }
        if (value === 16 && !i) invalid();
        const repeat = value === 16 ? bits(2) + 3 : value === 17 ? bits(3) + 3 : bits(7) + 11;
        if (i + repeat > lengths.length) invalid();
        lengths.fill(value === 16 ? lengths[i - 1] : 0, i, i + repeat); i += repeat;
      }
      if (!lengths[256]) invalid();
      literal = tree(lengths.subarray(0, literals));
      distance = tree(lengths.subarray(literals), true);
    }
    for (;;) {
      const value = symbol(literal);
      if (value === 256) break;
      if (value < 256) {
        if (written === output.length) invalid();
        output[written++] = value;
      } else {
        const index = value - 257;
        if (index >= lengthBase.length) invalid();
        const length = lengthBase[index] + bits(lengthExtra[index]);
        const distSymbol = symbol(distance);
        if (distSymbol >= distanceBase.length) invalid();
        const dist = distanceBase[distSymbol] + bits(distanceExtra[distSymbol]);
        if (dist > written || written + length > output.length) invalid();
        for (let i = 0; i < length; i++) { output[written] = output[written - dist]; written++; }
      }
    }
  } while (!final);
  if (written !== decodedLength || Math.ceil(position / 8) !== data.length) invalid();
  return output;
}
