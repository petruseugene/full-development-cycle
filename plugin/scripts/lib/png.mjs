// Dependency-free PNG decoder (colour types 2/6, 8-bit, non-interlaced).
// Returns {width,height,channels,data} | {unsupported} | {error}; never throws.
import fs from 'node:fs';
import zlib from 'node:zlib';

export const MAX_PNG_BYTES = 50 * 1024 * 1024;
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Real screenshots are well under these; checked from IHDR before any inflate or
// allocation (security W4). Inflate is also capped with maxOutputLength.
export const MAX_PIXELS = 40_000_000;
export const MAX_DECODED_BYTES = 160 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, x >= bpp && y > 0 ? out[prev + x - bpp] : 0); break;
        default: return null;
      }
      out[dst + x] = r & 0xff;
    }
  }
  return out;
}

export function decodePng(input) {
  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (buf.length < 8 || SIG.some((b, i) => buf[i] !== b)) return { error: 'not a PNG (bad signature)' };
    let pos = 8;
    let ihdr = null;
    const idat = [];
    let ended = false;
    while (pos + 12 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const end = pos + 8 + len;
      if (end + 4 > buf.length) return { error: 'truncated PNG chunk' };
      const type = buf.toString('latin1', pos + 4, pos + 8);
      if (crc32(buf, pos + 4, end) !== buf.readUInt32BE(end)) return { error: `bad CRC in ${type} chunk` };
      if (type === 'IHDR') {
        if (len !== 13) return { error: 'bad IHDR length' };
        ihdr = {
          width: buf.readUInt32BE(pos + 8), height: buf.readUInt32BE(pos + 12),
          depth: buf[pos + 16], colorType: buf[pos + 17], interlace: buf[pos + 20],
        };
      } else if (type === 'IDAT') idat.push(buf.subarray(pos + 8, end));
      else if (type === 'IEND') { ended = true; break; }
      pos = end + 4;
    }
    if (!ihdr) return { error: 'missing IHDR' };
    if (!ended) return { error: 'truncated PNG (no IEND)' };
    if (ihdr.interlace !== 0) return { unsupported: 'interlaced PNG' };
    if (ihdr.depth !== 8) return { unsupported: `bit depth ${ihdr.depth}` };
    if (ihdr.colorType !== 2 && ihdr.colorType !== 6) return { unsupported: `colour type ${ihdr.colorType}` };
    const { width, height } = ihdr;
    if (!width || !height) return { error: 'invalid dimensions' };
    if (width * height > MAX_PIXELS) return { error: `PNG too large (${width}x${height} > ${MAX_PIXELS} pixels)` };
    if (!idat.length) return { error: 'missing IDAT' };
    const channels = ihdr.colorType === 6 ? 4 : 3;
    const expected = (width * channels + 1) * height;
    if (expected > MAX_DECODED_BYTES) return { error: `PNG too large (${expected} decoded bytes > ${MAX_DECODED_BYTES})` };
    let raw;
    try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); }
    catch (e) { return { error: `inflate failed: ${e.message}` }; }
    if (raw.length !== expected) return { error: 'decoded data size mismatch' };
    const data = unfilter(raw, width, height, channels);
    if (!data) return { error: 'invalid filter type' };
    return { width, height, channels, data };
  } catch (e) {
    return { error: `decode failed: ${e && e.message}` };
  }
}

export function decodePngFile(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_PNG_BYTES) return { error: `PNG larger than ${MAX_PNG_BYTES} bytes` };
    return decodePng(fs.readFileSync(file));
  } catch (e) {
    return { error: `cannot read PNG: ${e.message}` };
  }
}
