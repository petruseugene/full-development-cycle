import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { UsageError } from '../plugin/scripts/lib/core.mjs';
import { runWith, mergeResults } from '../plugin/scripts/lib/visual-check.mjs';
import { mkFixture, mkCtx, FIXTURES_DIR } from './helpers.mjs';

const FIX = path.join(FIXTURES_DIR, 'visual-check');
const fixtureText = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

// ---- PNG generator ------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function makePng({ w = 100, h = 100, magenta = 0, depth = 8, interlace = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = 6; ihdr[12] = interlace;
  const rows = [];
  let left = magenta;
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const o = 1 + x * 4;
      if (left > 0) { row.set([255, 0, 255, 255], o); left--; } else row.set([255, 255, 255, 255], o);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- fixture helpers ----------------------------------------------------
function setup(t) {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  fx.write('.dev-cycle/project.json', fixtureText('project.json'));
  const vdir = path.join(fx.featureDir, 'verification');
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, 's.png'), makePng());
  fs.writeFileSync(path.join(vdir, 'h.json'), fixtureText('maestro-hierarchy.json'));
  const ctx = mkCtx({ cwd: fx.root });
  const check = async (...argv) => {
    const c = mkCtx({ cwd: fx.root });
    const code = await runWith(argv, c).catch((e) => (e instanceof UsageError ? 2 : Promise.reject(e)));
    return { code, out: c.out() };
  };
  const manifest = () => JSON.parse(fs.readFileSync(path.join(vdir, 'manifest.json'), 'utf8'));
  const dom = (name, elements) => { fs.writeFileSync(path.join(vdir, name), JSON.stringify({ elements })); return name; };
  return { fx, vdir, ctx, check, manifest, dom };
}
const res = (m, screen, type, subject) => m.screens[screen].checks.find((c) => c.type === type && c.subject === subject);
const box = (x, y, width, height) => ({ x, y, width, height });

test('AC8: Maestro hierarchy + profile: scale/overlap/tap/support with source hierarchy', async (t) => {
  const s = setup(t);
  const r = await s.check('lis', '--screenshot', 's.png', '--hierarchy', 'h.json');
  assert.equal(r.code, 0);
  const m = s.manifest();
  const scale = res(m, 'lis', 'scale', 'friend/hero');
  assert.equal(scale.result, 'fail'); assert.equal(scale.measured, 0.85); assert.equal(scale.source, 'hierarchy');
  assert.equal(res(m, 'lis', 'overlap', 'bubble/hero').result, 'pass'); // adjacent boxes
  const tap = res(m, 'lis', 'tap', 'cta');
  assert.equal(tap.result, 'fail'); assert.equal(tap.measured, 43);
  assert.equal(res(m, 'lis', 'support', 'friend').result, 'fail');
  assert.ok(m.screens.lis.checks.every((c) => c.source === 'hierarchy'));
  assert.ok(m.last_activity); assert.equal(m.screens.lis.screenshot, 's.png');
});

test('AC8: h=92 passes scale; support 3% pass / 12% fail / centre outside fails; overlap 1px2 fails', async (t) => {
  const s = setup(t);
  const base = { hero: box(100, 400, 200, 100), perch: box(80, 500, 320, 40), bubble: box(300, 300, 200, 100), cta: box(10, 700, 44, 60) };
  const run = async (friend, extra = {}) => {
    await s.check('lis', '--screenshot', 's.png', '--hierarchy', s.dom('d.json', { ...base, friend, ...extra }));
    return s.manifest();
  };
  let m = await run(box(120, 408, 100, 92)); // bottom 500, gap 0
  assert.equal(res(m, 'lis', 'scale', 'friend/hero').result, 'pass');
  assert.equal(res(m, 'lis', 'support', 'friend').result, 'pass');
  assert.equal(res(m, 'lis', 'support', 'friend').source, 'dom');
  m = await run(box(120, 408 + 2.76, 100, 92)); // 3% of 92 below
  assert.equal(res(m, 'lis', 'support', 'friend').result, 'pass');
  m = await run(box(120, 408 - 11.04, 100, 92)); // 12% above
  assert.equal(res(m, 'lis', 'support', 'friend').result, 'fail');
  m = await run(box(500, 408, 100, 92)); // centre 550 outside perch 80..400
  assert.equal(res(m, 'lis', 'support', 'friend').result, 'fail');
  m = await run(box(120, 408, 100, 92), { bubble: box(299, 399, 200, 100) });
  assert.equal(res(m, 'lis', 'overlap', 'bubble/hero').result, 'fail');
});

test('AC8: element missing without --measure is unmeasured', async (t) => {
  const s = setup(t);
  await s.check('ghosty', '--screenshot', 's.png', '--hierarchy', 'h.json');
  const c = res(s.manifest(), 'ghosty', 'scale', 'ghost/hero');
  assert.equal(c.result, 'unmeasured'); assert.equal(c.measured, null);
});

test('AC9: vision measures use the tolerance; bad value exits 2', async (t) => {
  const s = setup(t);
  await s.check('ghosty', '--screenshot', 's.png', '--measure', 'scale:ghost/hero=0.89', '--source', 'vision');
  let c = res(s.manifest(), 'ghosty', 'scale', 'ghost/hero');
  assert.equal(c.result, 'fail'); assert.equal(c.source, 'vision');
  await s.check('ghosty', '--screenshot', 's.png', '--measure', 'scale:ghost/hero=0.91', '--source', 'vision');
  c = res(s.manifest(), 'ghosty', 'scale', 'ghost/hero');
  assert.equal(c.result, 'pass'); assert.equal(c.source, 'vision');
  assert.equal((await s.check('ghosty', '--screenshot', 's.png', '--measure', 'scale:ghost/hero=abc', '--source', 'vision')).code, 2);
  assert.equal((await s.check('ghosty', '--screenshot', 's.png', '--source', 'pixels')).code, 2);
});

test('AC9: a CLI fail is never turned into pass by a later call or a same-call measure', async (t) => {
  const s = setup(t);
  await s.check('lis', '--screenshot', 's.png', '--hierarchy', 'h.json');
  // same call: vision measure for a check the hierarchy computed
  await s.check('lis', '--screenshot', 's.png', '--hierarchy', 'h.json', '--measure', 'scale:friend/hero=1', '--source', 'vision');
  assert.equal(res(s.manifest(), 'lis', 'scale', 'friend/hero').result, 'fail');
  // later call: only a measure for a different check
  await s.check('lis', '--screenshot', 's.png', '--measure', 'tap:cta=60', '--source', 'vision');
  const m = s.manifest();
  assert.equal(res(m, 'lis', 'scale', 'friend/hero').result, 'fail');
  assert.equal(res(m, 'lis', 'scale', 'friend/hero').source, 'hierarchy');
  assert.equal(res(m, 'lis', 'tap', 'cta').result, 'fail'); // CLI fail kept over vision pass
  assert.equal(res(m, 'lis', 'overlap', 'bubble/hero').result, 'pass'); // not downgraded to unmeasured
});

test('unmeasured is filled by a later vision measure for the same check only', async (t) => {
  const s = setup(t);
  await s.check('ghosty', '--screenshot', 's.png', '--hierarchy', 'h.json');
  assert.equal(res(s.manifest(), 'ghosty', 'scale', 'ghost/hero').result, 'unmeasured');
  await s.check('ghosty', '--screenshot', 's.png', '--measure', 'scale:ghost/hero=1', '--source', 'vision');
  assert.equal(res(s.manifest(), 'ghosty', 'scale', 'ghost/hero').result, 'pass');
});

test('--fail reasons append; adhoc screens register; unknown id exits 2', async (t) => {
  const s = setup(t);
  await s.check('lis', '--screenshot', 's.png', '--fail', 'console error: x');
  await s.check('lis', '--screenshot', 's.png', '--fail', 'request failed', '--fail', 'console error: x');
  assert.deepEqual(s.manifest().screens.lis.failures, ['console error: x', 'request failed']);
  assert.equal((await s.check('nope', '--screenshot', 's.png')).code, 2);
  assert.equal((await s.check('nope', '--screenshot', 's.png', '--adhoc')).code, 0);
  const a = s.manifest().screens.nope;
  assert.equal(a.adhoc, true); assert.equal(a.reference, 'none'); assert.deepEqual(a.checks, []);
});

test('AC10: colours 0.2% fail, 0.05% pass (real decoder)', async (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.vdir, 'p20.png'), makePng({ magenta: 20 }));
  fs.writeFileSync(path.join(s.vdir, 'p5.png'), makePng({ magenta: 5 }));
  await s.check('pix', '--screenshot', 'p20.png');
  let c = res(s.manifest(), 'pix', 'colors', '#FF00FF');
  assert.equal(c.result, 'fail'); assert.equal(c.source, 'pixels'); assert.equal(c.measured, 0.2);
  await s.check('pix', '--screenshot', 'p5.png');
  c = res(s.manifest(), 'pix', 'colors', '#FF00FF');
  assert.equal(c.result, 'pass'); assert.equal(c.measured, 0.05);
});

test('AC10: interlaced, 16-bit and truncated PNGs give unmeasured', async (t) => {
  const s = setup(t);
  const good = makePng({ magenta: 20 });
  const cases = { 'i.png': makePng({ interlace: 1 }), 'd.png': makePng({ depth: 16 }), 't.png': good.subarray(0, good.length - 20) };
  for (const [name, buf] of Object.entries(cases)) {
    fs.writeFileSync(path.join(s.vdir, name), buf);
    const r = await s.check('pix', '--screenshot', name);
    assert.equal(r.code, 0, name);
    assert.equal(res(s.manifest(), 'pix', 'colors', '#FF00FF').result, 'unmeasured', name);
  }
  // a vision measure may fill it
  await s.check('pix', '--screenshot', 'i.png', '--measure', 'colors:#FF00FF=0.5', '--source', 'vision');
  const c = res(s.manifest(), 'pix', 'colors', '#FF00FF');
  assert.equal(c.result, 'fail'); assert.equal(c.source, 'vision');
});

test('pixels are not decoded when the screen has no colors check', async (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.vdir, 'junk.png'), 'not a png');
  assert.equal((await s.check('lis', '--screenshot', 'junk.png', '--hierarchy', 'h.json')).code, 0);
});

test('AC11: path guard exits 2 for .., absolute outside and outside symlinks', async (t) => {
  const s = setup(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-out-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'x.png'), makePng());
  fs.symlinkSync(path.join(outside, 'x.png'), path.join(s.vdir, 'link.png'));
  fs.symlinkSync(outside, path.join(s.vdir, 'linkdir'));
  for (const p of ['../../../etc/passwd', path.join(outside, 'x.png'), 'link.png', 'linkdir/x.png', 'missing.png']) {
    assert.equal((await s.check('lis', '--screenshot', p)).code, 2, p);
  }
  assert.equal((await s.check('lis', '--screenshot', 's.png', '--hierarchy', path.join(outside, 'x.png'))).code, 2);
  assert.equal((await s.check('lis')).code, 2); // --screenshot is required
});

test('mergeResults: same check replaced, others kept', () => {
  const old = [{ type: 'a', subject: 'x', result: 'pass', source: 'dom' }, { type: 'b', subject: 'y', result: 'fail', source: 'dom' }];
  const out = mergeResults(old, [{ type: 'a', subject: 'x', result: 'fail', source: 'dom' }]);
  assert.deepEqual(out.map((c) => c.result), ['fail', 'fail']);
});

test('W5: --adhoc screen ids are validated like mark; __proto__ cannot corrupt the manifest', async (t) => {
  const s = setup(t);
  for (const id of ['__proto__', '../x', 'a/b', '-x', 'Bad']) {
    const r = await s.check(id, '--screenshot', 's.png', '--adhoc');
    assert.equal(r.code, 2, id);
  }
  assert.equal((await s.check('ok-1', '--screenshot', 's.png', '--adhoc')).code, 0);
  assert.equal((await s.check('constructor', '--screenshot', 's.png', '--adhoc', '--fail', 'x')).code, 0);
  const m = s.manifest();
  assert.ok(Object.hasOwn(m.screens, 'constructor'));
  assert.deepEqual(m.screens.constructor.failures, ['x']);
  assert.equal(Object.getPrototypeOf(m.screens), Object.prototype);
  assert.ok(Object.hasOwn(m.screens, 'ok-1'));
  assert.ok(!Object.hasOwn(m.screens, '__proto__'));
});

test('re-run: mark start begins a fresh attempt (no --fail reason or result carried over)', async (t) => {
  const { runWith: mark } = await import('../plugin/scripts/lib/visual-mark.mjs');
  const s = setup(t);
  const m = (verb) => mark(['lis', verb], mkCtx({ cwd: s.fx.root }));
  await m('start');
  assert.equal((await s.check('lis', '--screenshot', 's.png', '--hierarchy', 'h.json', '--fail', 'console error: x')).code, 0);
  await m('end');
  const before = s.manifest().screens.lis;
  assert.deepEqual(before.failures, ['console error: x']);
  assert.ok(before.checks.length > 0);
  await m('start');
  const after = s.manifest().screens.lis;
  for (const k of ['failures', 'checks', 'screenshot', 'ended_at', 'duration_s', 'overrun', 'result']) {
    assert.equal(after[k], undefined, k);
  }
  assert.equal(after.id, 'lis');
  assert.equal(after.reference, before.reference);
  assert.equal(after.timeout_s, before.timeout_s);
  await s.check('lis', '--screenshot', 's.png');
  assert.deepEqual(s.manifest().screens.lis.failures, []);
});

test('re-run: an ad-hoc screen keeps adhoc and gets an empty checks list on a new start', async (t) => {
  const { runWith: mark } = await import('../plugin/scripts/lib/visual-mark.mjs');
  const s = setup(t);
  await s.check('extra', '--screenshot', 's.png', '--adhoc', '--fail', 'boom');
  await mark(['extra', 'start'], mkCtx({ cwd: s.fx.root }));
  const e = s.manifest().screens.extra;
  assert.equal(e.adhoc, true);
  assert.deepEqual(e.checks, []);
  assert.equal(e.failures, undefined);
});
