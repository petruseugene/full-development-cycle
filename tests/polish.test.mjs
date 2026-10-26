import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { mkGitRepo } from './git-helpers.mjs';
import { parsePlan } from '../plugin/scripts/lib/plan.mjs';
import { isDeferred, parseItems, readPolish, sanitizeItemText, validateTouch } from '../plugin/scripts/lib/polish.mjs';

const ITEMS = [
  { title: 'Home title clipped', area: 'home', touches: ['src/home/**'], screen: 'Home' },
  { title: 'Settings toggle wrong colour', area: 'settings', touches: ['src/settings/**', 'src/theme.ts'] },
  { title: 'Home subtitle overlaps', area: 'home', touches: ['src/home/**', 'src/home/sub.ts'], tag: 'backend' },
];

function polishFixture(over = {}) {
  const fx = mkGitRepo({ featureJson: sampleFeatureJson({ track: 'polish', has_ui: true, ...over }) });
  const items = fx.write('items.json', JSON.stringify(ITEMS));
  const cli = (args) => runCli([...args, '--feature', fx.featureDir], { cwd: fx.root });
  return { fx, items, cli };
}

const readFj = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'feature.json'), 'utf8'));

test('AC1: feature init accepts track polish; bad track lists polish', () => {
  const fx = mkFixture();
  try {
    const r = runCli(['feature', 'init', 'x', '--flow', 'feature', '--track', 'polish'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const fj = readFj(r.stdout.trim());
    assert.equal(fj.track, 'polish');
    assert.equal(fj.discovery, 'skip');
    assert.equal(fj.current_phase, 'implement');
    assert.ok(!('separate_plan' in fj));
    const bad = runCli(['feature', 'init', 'y', '--flow', 'feature', '--track', 'nope'], { cwd: fx.root });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /full\|lite\|quick\|polish/);
  } finally { fx.cleanup(); }
});

test('AC2/AC3: polish init writes polish.md, areas and untracked baseline', () => {
  const { fx, items, cli } = polishFixture();
  try {
    fx.write('scratch.txt', 'x');
    fx.write(`docs/features/2026-01-01-00h-00m-sample/note.txt`, 'x');
    const r = cli(['polish', 'init', '--items', items]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'polish: 3 items in 2 areas');
    const text = fs.readFileSync(path.join(fx.featureDir, 'polish.md'), 'utf8');
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((t) => t.tag), ['frontend', 'frontend', 'backend']);
    assert.deepEqual(tasks[1].touches, ['src/settings/**', 'src/theme.ts']);
    const p = parseItems(text);
    assert.deepEqual(p.map((i) => i.id), ['P1', 'P2', 'P3']);
    assert.equal(p[0].screen, 'Home');
    assert.equal(p[1].screen, null);
    assert.equal(p[0].deferred, null);
    assert.equal(p[0].area, 'home');
    const fj = readFj(fx.featureDir);
    assert.deepEqual(fj.areas, [
      { name: 'home', touches: ['src/home/**', 'src/home/sub.ts'] },
      { name: 'settings', touches: ['src/settings/**', 'src/theme.ts'] },
    ]);
    assert.ok(fj.untracked_baseline.includes('scratch.txt'));
    assert.ok(fj.untracked_baseline.includes('items.json'));
    assert.ok(!fj.untracked_baseline.some((p2) => p2.startsWith('docs/features/2026-01-01-00h-00m-sample/')));
    assert.equal(readPolish(fx.featureDir).items.length, 3);
  } finally { fx.cleanup(); }
});

test('AC4: polish init rejects invalid input and writes nothing', () => {
  const { fx, cli } = polishFixture();
  const write = (arr) => fx.write('bad.json', JSON.stringify(arr));
  const ok = { title: 't', area: 'a', touches: ['src/a.ts'] };
  const cases = {
    zero: [],
    tooMany: Array.from({ length: 21 }, () => ok),
    emptyTitle: [{ ...ok, title: '\u200b# ' }],
    badArea: [{ ...ok, area: 'Bad Area' }],
    absolute: [{ ...ok, touches: ['/etc/passwd'] }],
    dotdot: [{ ...ok, touches: ['src/../x'] }],
    dash: [{ ...ok, touches: ['-rf'] }],
    tick: [{ ...ok, touches: ['src/`x`'] }],
    broad: [{ ...ok, touches: ['**'] }],
  };
  try {
    for (const [name, arr] of Object.entries(cases)) {
      const r = cli(['polish', 'init', '--items', write(arr)]);
      assert.equal(r.status, 2, `${name}: ${r.stderr}`);
      assert.ok(!fs.existsSync(path.join(fx.featureDir, 'polish.md')), name);
      assert.equal(readFj(fx.featureDir).areas, undefined, name);
    }
    const first = cli(['polish', 'init', '--items', write([ok])]);
    assert.equal(first.status, 0, first.stderr);
    const again = cli(['polish', 'init', '--items', write([ok])]);
    assert.equal(again.status, 2);
    const wrong = mkFixture({ featureJson: sampleFeatureJson({ track: 'lite' }) });
    try {
      const w = runCli(['polish', 'init', '--items', write([ok]), '--feature', wrong.featureDir], { cwd: fx.root });
      assert.equal(w.status, 2);
    } finally { wrong.cleanup(); }
  } finally { fx.cleanup(); }
});

test('AC5: titles are sanitized to one line and cut at 100 chars', () => {
  const { fx, cli } = polishFixture();
  try {
    const items = fx.write('t.json', JSON.stringify([
      { title: '## line one\nline\u202e two\u200b', area: 'a', touches: ['src/a.ts'] },
      { title: 'x'.repeat(150), area: 'a', touches: ['src/b.ts'] },
    ]));
    const r = cli(['polish', 'init', '--items', items]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /P2 title cut to 100 chars/);
    const [a, b] = readPolish(fx.featureDir).items;
    assert.equal(a.title, 'line one line two');
    assert.equal(b.title.length, 100);
    assert.ok(b.title.endsWith('…'));
    assert.ok(!/[\u202e\u200b]/.test(fs.readFileSync(path.join(fx.featureDir, 'polish.md'), 'utf8')));
  } finally { fx.cleanup(); }
});

test('sanitizeItemText / validateTouch units', () => {
  assert.equal(sanitizeItemText('abc', 10), 'abc');
  assert.equal(sanitizeItemText('abcdef', 4), 'abc…');
  assert.equal(validateTouch('src/a.ts'), null);
  for (const bad of ['', '/a', 'a/../b', '-x', 'a,b', '*', 'a\0b', 'C:\\x']) assert.notEqual(validateTouch(bad), null, bad);
});

test('AC6: task status flips an item in polish.md with no plan/spec', () => {
  const { fx, items, cli } = polishFixture();
  try {
    assert.equal(cli(['polish', 'init', '--items', items]).status, 0);
    const r = cli(['task', '1', 'status', 'IMPL-DONE']);
    assert.equal(r.status, 0, r.stderr);
    const list = readPolish(fx.featureDir).items;
    assert.equal(list[0].status, 'IMPL-DONE');
    assert.equal(list[1].status, 'TODO');
  } finally { fx.cleanup(); }
});

test('AC7: polish defer adds token + field, replaces, and rejects bad input', () => {
  const { fx, items, cli } = polishFixture();
  try {
    assert.equal(cli(['polish', 'init', '--items', items]).status, 0);
    const r = cli(['polish', 'defer', '2', '--reason', 'needs new API']);
    assert.equal(r.status, 0, r.stderr);
    let it = readPolish(fx.featureDir).items[1];
    assert.equal(it.deferred, 'needs new API');
    assert.ok(isDeferred(it));
    assert.equal(it.tag, 'frontend, deferred');
    const text = fs.readFileSync(path.join(fx.featureDir, 'polish.md'), 'utf8');
    assert.match(text, /\(frontend, deferred\): Settings toggle/);
    assert.match(text, /\*\*Deferred:\*\* needs new API/);
    assert.equal(cli(['polish', 'defer', '2', '--reason', 'other reason']).status, 0);
    it = readPolish(fx.featureDir).items[1];
    assert.equal(it.deferred, 'other reason');
    assert.equal(fs.readFileSync(path.join(fx.featureDir, 'polish.md'), 'utf8').match(/\*\*Deferred:\*\*/g).length, 1);
    assert.equal(readPolish(fx.featureDir).items[0].deferred, null);
    assert.equal(cli(['polish', 'defer', '1', '--reason', ' \u200b ']).status, 2);
    assert.equal(cli(['polish', 'defer', '9', '--reason', 'x']).status, 2);
    cli(['task', '1', 'status', 'DONE']);
    assert.equal(cli(['polish', 'defer', '1', '--reason', 'x']).status, 2);
  } finally { fx.cleanup(); }
});

test('AC8: polish touches appends to item and area; invalid glob changes nothing', () => {
  const { fx, items, cli } = polishFixture();
  try {
    assert.equal(cli(['polish', 'init', '--items', items]).status, 0);
    const before = fs.readFileSync(path.join(fx.featureDir, 'polish.md'), 'utf8');
    const r = cli(['polish', 'touches', '1', '--add', 'src/x.ts']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readPolish(fx.featureDir).items[0].touches, ['src/home/**', 'src/x.ts']);
    assert.deepEqual(readFj(fx.featureDir).areas[0].touches, ['src/home/**', 'src/home/sub.ts', 'src/x.ts']);
    const mid = fs.readFileSync(path.join(fx.featureDir, 'polish.md'), 'utf8');
    assert.notEqual(mid, before);
    const fjBefore = fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8');
    assert.equal(cli(['polish', 'touches', '1', '--add', 'src/ok.ts,../bad']).status, 2);
    assert.equal(fs.readFileSync(path.join(fx.featureDir, 'polish.md'), 'utf8'), mid);
    assert.equal(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'), fjBefore);
  } finally { fx.cleanup(); }
});

test('AC9: polish list prints lines, re-sanitizes, and --json prints items', () => {
  const { fx, items, cli } = polishFixture();
  try {
    assert.equal(cli(['polish', 'init', '--items', items]).status, 0);
    cli(['task', '1', 'status', 'IMPL-DONE']);
    cli(['polish', 'defer', '2', '--reason', 'needs API']);
    const file = path.join(fx.featureDir, 'polish.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Home subtitle overlaps', 'Home sub\u202etitle overlaps'));
    const r = cli(['polish', 'list']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], 'P1 [IMPL-DONE] (home) Home title clipped');
    assert.equal(lines[1], 'P2 [TODO] (settings) Settings toggle wrong colour — deferred: needs API');
    assert.equal(lines[2], 'P3 [TODO] (home) Home subtitle overlaps');
    assert.ok(!r.stdout.includes('\u202e'));
    const j = JSON.parse(cli(['polish', 'list', '--json']).stdout);
    assert.equal(j.length, 3);
    assert.equal(j[1].deferred, 'needs API');
  } finally { fx.cleanup(); }
});
