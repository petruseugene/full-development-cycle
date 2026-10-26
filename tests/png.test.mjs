import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePng, decodePngFile } from '../plugin/scripts/lib/png.mjs';

const T = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); }
  return t;
})();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

// Encode pixels (width*height*ch bytes) using the given filter type for every row.
function encode(w, h, ch, pix, filter = 0, { depth = 8, interlace = 0, colorType } = {}) {
  const stride = w * ch;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(stride + 1);
    row[0] = filter;
    for (let x = 0; x < stride; x++) {
      const v = pix[y * stride + x];
      const a = x >= ch ? pix[y * stride + x - ch] : 0;
      const b = y ? pix[(y - 1) * stride + x] : 0;
      const c = x >= ch && y ? pix[(y - 1) * stride + x - ch] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      row[x + 1] = (v - pred) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth; ihdr[9] = colorType ?? (ch === 4 ? 6 : 2); ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pixels = (w, h, ch) => {
  const p = Buffer.alloc(w * h * ch);
  for (let i = 0; i < p.length; i++) p[i] = (i * 37 + (i >> 3) * 11 + 5) & 0xff;
  return p;
};

for (const ch of [3, 4]) {
  for (let f = 0; f <= 4; f++) {
    test(`decodes filter type ${f} with ${ch} channels`, () => {
      const pix = pixels(7, 5, ch);
      const r = decodePng(encode(7, 5, ch, pix, f));
      assert.equal(r.error, undefined);
      assert.equal(r.width, 7); assert.equal(r.height, 5); assert.equal(r.channels, ch);
      assert.deepEqual(Buffer.from(r.data), pix);
    });
  }
}

test('interlaced and 16-bit and palette return unsupported', () => {
  assert.ok(decodePng(encode(2, 2, 4, pixels(2, 2, 4), 0, { interlace: 1 })).unsupported);
  assert.ok(decodePng(encode(2, 2, 4, pixels(2, 2, 4), 0, { depth: 16 })).unsupported);
  assert.ok(decodePng(encode(2, 2, 3, pixels(2, 2, 3), 0, { colorType: 3 })).unsupported);
  assert.ok(decodePng(encode(2, 2, 3, pixels(2, 2, 3), 0, { colorType: 0 })).unsupported);
});

test('truncated, corrupt and garbage input return error without throwing', () => {
  const good = encode(4, 4, 4, pixels(4, 4, 4), 1);
  assert.ok(decodePng(good.subarray(0, good.length - 10)).error);
  assert.ok(decodePng(good.subarray(0, 20)).error);
  const bad = Buffer.from(good); bad[bad.length - 20] ^= 0xff;
  assert.ok(decodePng(bad).error);
  assert.ok(decodePng(Buffer.from('nope')).error);
  assert.ok(decodePng(Buffer.alloc(0)).error);
});

test('decodePngFile reads files and reports missing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'png-'));
  const f = path.join(dir, 'a.png');
  fs.writeFileSync(f, encode(3, 3, 4, pixels(3, 3, 4), 4));
  assert.equal(decodePngFile(f).width, 3);
  assert.ok(decodePngFile(path.join(dir, 'missing.png')).error);
});

test('1290x2796 RGBA decodes and scans in under 3s', () => {
  const w = 1290, h = 2796;
  const pix = Buffer.alloc(w * h * 4, 0x7f);
  const png = encode(w, h, 4, pix, 2);
  const t0 = Date.now();
  const r = decodePng(png);
  let hits = 0;
  for (let i = 0; i < r.data.length; i += 4) if (r.data[i] === 255 && r.data[i + 1] === 0 && r.data[i + 2] === 255) hits++;
  assert.equal(hits, 0);
  assert.equal(r.width, w);
  assert.ok(Date.now() - t0 < 3000);
});

test('W4: pixel and decoded-byte caps are checked from IHDR before inflating', async () => {
  const { MAX_PIXELS, MAX_DECODED_BYTES } = await import('../plugin/scripts/lib/png.mjs');
  assert.ok(MAX_PIXELS <= 40_000_000);
  assert.ok(MAX_DECODED_BYTES <= 160 * 1024 * 1024);
  // Header-only PNG: IHDR claims a huge image, IDAT is tiny (would fail inflate if reached).
  const header = (w, h, colorType) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0)),
    ]);
  };
  assert.match(decodePng(header(10000, 10000, 6)).error, /too large .*pixels/);
  assert.match(decodePng(header(6000, 7000, 6)).error, /too large/);
  // Worst case under the pixel cap still fits the decoded-byte budget (inflate maxOutputLength).
  assert.ok((6324 * 4 + 1) * 6324 <= MAX_DECODED_BYTES);
  // A real-sized screenshot header is not rejected by the caps (fails later on data size).
  assert.doesNotMatch(String(decodePng(header(1290, 2796, 6)).error), /too large/);
});
