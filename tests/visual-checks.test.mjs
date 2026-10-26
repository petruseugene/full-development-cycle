import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseMaestroHierarchy, parseDomRects, parseMeasure, evaluateChecks, colorPct,
} from '../plugin/scripts/lib/visual-checks.mjs';
import { decodePng } from '../plugin/scripts/lib/png.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'visual-checks');
const hier = () => parseMaestroHierarchy(fs.readFileSync(path.join(FX, 'maestro-hierarchy.json'), 'utf8'));
const withBox = (boxes, id, box) => new Map(boxes).set(id, box);

const screen = {
  elements: {
    hero: 'hero', friend: { id: 'friend', foot_offset_pct: 0, support_offset_pct: 0 },
    perch: 'perch', bubble: 'bubble', cta: 'cta', ghost: 'ghost',
  },
  checks: [],
};
const one = (check, opts = {}) => evaluateChecks({ ...screen, checks: [check] }, {
  visual: { tolerance_pct: 10, tap_min_pt: 44, ...opts.visual }, boxes: hier(), boxSource: 'hierarchy', ...opts,
})[0];

// ---- PNG helpers --------------------------------------------------------
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
function png(w, h, rgba, { depth = 8, interlace = 0, colorType = 6 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0]), Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function canvas(w, h, magentaPixels) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = 255; px[i * 4 + 1] = 255; px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; }
  for (let i = 0; i < magentaPixels; i++) { px[i * 4] = 255; px[i * 4 + 1] = 0; px[i * 4 + 2] = 255; }
  return px;
}
const colorsOpts = (decoded, extra = {}) => ({
  visual: { forbidden_colors: ['#FF00FF'], color_delta_e: 10, color_min_pct: 0.1 }, png: decoded, ...extra,
});

// ---- parsers ------------------------------------------------------------
test('parseMaestroHierarchy walks nested tree and ignores malformed nodes', () => {
  const m = hier();
  assert.deepEqual(m.get('hero'), { x: 100, y: 400, width: 200, height: 100 });
  assert.equal(m.get('friend').height, 85); // accessibilityText
  assert.equal(m.get('perch').width, 320); // id
  assert.equal(m.has('broken'), false);
  assert.equal(m.has('inverted'), false);
});

test('parseDomRects reads elements and ignores malformed entries', () => {
  const m = parseDomRects(fs.readFileSync(path.join(FX, 'dom-rects.json'), 'utf8'));
  assert.deepEqual(m.get('hero'), { x: 100, y: 400, width: 200, height: 100 });
  assert.equal(m.has('bad'), false);
  assert.equal(m.has('nan'), false);
  assert.equal(parseDomRects({}).size, 0);
});

test('parseMeasure parses and rejects non-finite values', () => {
  assert.deepEqual(parseMeasure('scale:friend/hero=0.89'), { check: 'scale', subject: 'friend/hero', value: 0.89 });
  assert.deepEqual(parseMeasure('colors:#FF00FF=0.2'), { check: 'colors', subject: '#FF00FF', value: 0.2 });
  for (const bad of ['scale:friend/hero=abc', 'scale:a/b=', 'scale:a/b=Infinity', 'scale:a/b=NaN', 'nope', 'zzz:a=1']) {
    assert.throws(() => parseMeasure(bad), (e) => e.exitCode === 2 || e.code === 2 || /measure/.test(e.message), bad);
  }
});

// ---- AC8 ----------------------------------------------------------------
test('AC8 scale: 85/100 fails with measured 0.85, 92/100 passes', () => {
  const c = { type: 'scale', a: 'friend', b: 'hero', expect: 1.0 };
  const r = one(c);
  assert.equal(r.result, 'fail'); assert.equal(r.measured, 0.85); assert.equal(r.source, 'hierarchy');
  assert.equal(r.expected, 1); assert.equal(r.tolerance, 10);
  const boxes = withBox(hier(), 'friend', { x: 0, y: 0, width: 10, height: 92 });
  assert.equal(one(c, { boxes }).result, 'pass');
});

test('AC8 support: 3% pass, 12% fail, centre outside perch fails', () => {
  const c = { type: 'support', element: 'friend', on: 'perch' };
  // perch top 500; friend h=85 -> 3% of 85 = 2.55
  const at = (bottom, x = 120) => withBox(hier(), 'friend', { x, y: bottom - 85, width: 100, height: 85 });
  assert.equal(one(c, { boxes: at(500 - 2.55) }).result, 'pass');
  assert.equal(one(c, { boxes: at(500 - 0.12 * 85) }).result, 'fail');
  assert.equal(one(c, { boxes: at(500, 600) }).result, 'fail'); // centre 650 > 400
  assert.equal(one(c, { boxes: at(500) }).result, 'pass');
});

test('AC8 support honours foot_offset_pct and support_offset_pct', () => {
  const sc = { ...screen, elements: { ...screen.elements,
    friend: { id: 'friend', foot_offset_pct: 10, support_offset_pct: 0 },
    perch: { id: 'perch', foot_offset_pct: 0, support_offset_pct: 50 } } };
  // friend bottom 592, h 85 -> feet line 583.5 ; perch top 500 + 0.5*40 = 520 ; gap 63.5
  const [r] = evaluateChecks({ ...sc, checks: [{ type: 'support', element: 'friend', on: 'perch' }] },
    { visual: {}, boxes: hier(), boxSource: 'hierarchy' });
  assert.equal(r.result, 'fail');
  assert.equal(r.measured, Math.round((63.5 / 85) * 1e6) / 1e6);
});

test('AC8 overlap: 1 px2 intersection fails, adjacent passes', () => {
  const c = { type: 'overlap', a: 'bubble', b: 'hero' };
  // hero [100..300]x[400..500]; bubble currently x300..500,y300..400 (corner touch)
  assert.equal(one(c).result, 'pass');
  const adj = withBox(hier(), 'bubble', { x: 300, y: 400, width: 50, height: 50 });
  assert.equal(one(c, { boxes: adj }).result, 'pass');
  const hit = withBox(hier(), 'bubble', { x: 299, y: 399, width: 50, height: 50 });
  const r = one(c, { boxes: hit });
  assert.equal(r.result, 'fail'); assert.equal(r.source, 'hierarchy');
});

test('AC8 tap: 43x60 fails with tap_min_pt 44', () => {
  const r = one({ type: 'tap', elements: ['cta'] });
  assert.equal(r.result, 'fail'); assert.equal(r.measured, 43); assert.equal(r.expected, 44);
  const ok = withBox(hier(), 'cta', { x: 0, y: 0, width: 44, height: 44 });
  assert.equal(one({ type: 'tap', elements: ['cta'] }, { boxes: ok }).result, 'pass');
});

test('AC8 missing element without measure is unmeasured; dom source recorded', () => {
  const r = one({ type: 'scale', a: 'ghost', b: 'hero', expect: 1 });
  assert.equal(r.result, 'unmeasured'); assert.equal(r.source, 'hierarchy'); assert.equal(r.measured, null);
  const dom = parseDomRects(fs.readFileSync(path.join(FX, 'dom-rects.json'), 'utf8'));
  const d = one({ type: 'scale', a: 'friend', b: 'hero', expect: 1 }, { boxes: dom, boxSource: 'dom' });
  assert.equal(d.source, 'dom'); assert.equal(d.result, 'pass'); assert.equal(d.measured, 0.92);
  assert.equal(one({ type: 'overlap', a: 'ghost', b: 'hero' }).result, 'unmeasured');
  assert.equal(one({ type: 'support', element: 'ghost', on: 'perch' }).result, 'unmeasured');
  assert.equal(one({ type: 'tap', elements: ['ghost'] }).result, 'unmeasured');
});

// ---- AC9 ----------------------------------------------------------------
test('AC9 vision measure: 0.89 fails, 0.91 passes, source vision', () => {
  const c = { type: 'scale', a: 'ghost', b: 'hero', expect: 1 };
  const sub = 'ghost/hero';
  const f = one(c, { measures: [{ check: 'scale', subject: sub, value: 0.89 }] });
  assert.equal(f.result, 'fail'); assert.equal(f.source, 'vision');
  const p = one(c, { measures: [{ check: 'scale', subject: sub, value: 0.91 }] });
  assert.equal(p.result, 'pass'); assert.equal(p.source, 'vision');
});

test('AC9 vision measures for support, overlap, tap', () => {
  const m = (check, subject, value) => [{ check, subject, value }];
  assert.equal(one({ type: 'support', element: 'ghost', on: 'perch' }, { measures: m('support', 'ghost', 0.03) }).result, 'pass');
  assert.equal(one({ type: 'support', element: 'ghost', on: 'perch' }, { measures: m('support', 'ghost', -0.12) }).result, 'fail');
  assert.equal(one({ type: 'overlap', a: 'ghost', b: 'hero' }, { measures: m('overlap', 'ghost/hero', 0) }).result, 'pass');
  assert.equal(one({ type: 'overlap', a: 'ghost', b: 'hero' }, { measures: m('overlap', 'ghost/hero', 0.01) }).result, 'fail');
  assert.equal(one({ type: 'tap', elements: ['ghost'] }, { measures: m('tap', 'ghost', 40) }).result, 'fail');
});

test('AC9 CLI-computed result always wins over a measure for the same check', () => {
  const c = { type: 'scale', a: 'friend', b: 'hero', expect: 1 };
  const r = one(c, { measures: [{ check: 'scale', subject: 'friend/hero', value: 1.0 }] });
  assert.equal(r.result, 'fail'); assert.equal(r.source, 'hierarchy'); assert.equal(r.measured, 0.85);
  // a measure for a different check changes nothing
  const r2 = one(c, { measures: [{ check: 'tap', subject: 'cta', value: 100 }] });
  assert.equal(r2.result, 'fail');
  // a CLI pass is not downgraded either
  const boxes = withBox(hier(), 'friend', { x: 0, y: 0, width: 10, height: 100 });
  assert.equal(one(c, { boxes, measures: [{ check: 'scale', subject: 'friend/hero', value: 0.5 }] }).result, 'pass');
});

// ---- AC10 ---------------------------------------------------------------
test('AC10 colors: 20 px of #FF00FF fails, 5 px passes (100x100)', () => {
  const c = { type: 'colors' };
  const run = (n) => evaluateChecks({ checks: [c] }, colorsOpts(decodePng(png(100, 100, canvas(100, 100, n)))))[0];
  const f = run(20);
  assert.equal(f.result, 'fail'); assert.equal(f.source, 'pixels'); assert.equal(f.subject, '#FF00FF');
  assert.ok(Math.abs(f.measured - 0.2) < 1e-9);
  assert.equal(run(5).result, 'pass');
  assert.equal(run(0).result, 'pass');
});

test('AC10 colors: near colours within deltaE count, distant ones do not', () => {
  const px = canvas(10, 10, 0);
  for (let i = 0; i < 10; i++) { px[i * 4] = 250; px[i * 4 + 1] = 5; px[i * 4 + 2] = 250; px[i * 4 + 3] = 255; }
  const d = decodePng(png(10, 10, px));
  assert.ok(colorPct(d, '#FF00FF', 10) >= 10);
  assert.equal(colorPct(d, '#00FF00', 10), 0);
});

test('AC10 colors: unsupported / error PNG is unmeasured unless a vision measure is given', () => {
  const c = { checks: [{ type: 'colors' }] };
  const px = canvas(4, 4, 0);
  for (const variant of [{ interlace: 1 }, { depth: 16 }]) {
    const d = decodePng(png(4, 4, px, variant));
    assert.ok(d.unsupported, JSON.stringify(variant));
    assert.equal(evaluateChecks(c, colorsOpts(d))[0].result, 'unmeasured');
    const v = evaluateChecks(c, colorsOpts(d, { measures: [{ check: 'colors', subject: '#FF00FF', value: 0.5 }] }))[0];
    assert.equal(v.result, 'fail'); assert.equal(v.source, 'vision');
  }
  const trunc = decodePng(png(4, 4, px).subarray(0, 40));
  assert.ok(trunc.error);
  assert.equal(evaluateChecks(c, colorsOpts(trunc))[0].result, 'unmeasured');
  assert.equal(evaluateChecks(c, colorsOpts(null))[0].result, 'unmeasured');
});

test('AC10 colors: all five PNG filter types decode to the expected pixels', () => {
  const w = 5, h = 5, bpp = 3;
  const src = new Uint8Array(w * h * bpp).map((_, i) => (i * 37 + 11) & 0xff);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  const rows = [];
  for (let y = 0; y < h; y++) {
    const ft = y; // filter types 0..4, one per row
    const row = [ft];
    for (let x = 0; x < w * bpp; x++) {
      const cur = src[y * w * bpp + x];
      const a = x >= bpp ? src[y * w * bpp + x - bpp] : 0;
      const b = y > 0 ? src[(y - 1) * w * bpp + x] : 0;
      const c = x >= bpp && y > 0 ? src[(y - 1) * w * bpp + x - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][ft];
      row.push((cur - pred) & 0xff);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  const d = decodePng(file);
  assert.deepEqual(Array.from(d.data), Array.from(src));
});

test('AC10 colors: 1290x2796 scan finishes under 3 s', () => {
  const w = 1290, h = 2796;
  const px = canvas(w, h, 0);
  for (let i = 0; i < w * h; i++) { px[i * 4] = i & 0xff; px[i * 4 + 1] = (i >> 8) & 0xff; px[i * 4 + 2] = (i >> 4) & 0xff; }
  const d = { width: w, height: h, channels: 4, data: px };
  const t0 = Date.now();
  const r = evaluateChecks({ checks: [{ type: 'colors' }] }, colorsOpts(d))[0];
  const ms = Date.now() - t0;
  assert.ok(r.result === 'pass' || r.result === 'fail');
  assert.ok(ms < 3000, `scan took ${ms} ms`);
});

test('F8: colors measure subject matches the profile hex case-insensitively', () => {
  const c = { checks: [{ type: 'colors' }] };
  const r = evaluateChecks(c, colorsOpts(null, { measures: [parseMeasure('colors:#ff00ff=0.5')] }))[0];
  assert.equal(r.source, 'vision');
  assert.equal(r.result, 'fail');
  assert.equal(r.subject, '#FF00FF');
});

test('F9: per-check tolerance_pct / tap_min_pt are not honoured; unknownCheckKeys lists them', async () => {
  const { unknownCheckKeys, CHECK_KEYS } = await import('../plugin/scripts/lib/visual-checks.mjs');
  const scale = { type: 'scale', a: 'hero', b: 'friend', expect: 1, tolerance_pct: 90 };
  const withOverride = one(scale);
  const without = one({ type: 'scale', a: 'hero', b: 'friend', expect: 1 });
  assert.equal(withOverride.tolerance, 10);
  assert.equal(withOverride.result, without.result);
  assert.equal(one({ type: 'tap', elements: ['cta'], tap_min_pt: 1 }).expected, 44);
  assert.deepEqual(unknownCheckKeys(scale), ['tolerance_pct']);
  assert.deepEqual(unknownCheckKeys({ type: 'tap', elements: ['x'], tap_min_pt: 1 }), ['tap_min_pt']);
  assert.deepEqual(unknownCheckKeys({ type: 'support', element: 'a', on: 'b' }), []);
  assert.deepEqual(Object.keys(CHECK_KEYS).sort(), ['colors', 'overlap', 'scale', 'support', 'tap']);
});
