import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'report');

function mkRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-report-')));
  fs.cpSync(FIXTURES, path.join(root, 'docs', 'features'), { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixtures');
  return { root, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const html = (dir) => walk(dir).filter((f) => f.endsWith('.html'));
const stripGenerated = (s) => s.replace(/Generated at <span class="num">[^<]*<\/span>/g, 'G');

test('--all: exit 0, file set, .gitignore, clean git status', () => {
  const r = mkRepo();
  try {
    const res = runCli(['report', '--no-network'], { cwd: r.root });
    assert.equal(res.status, 0, res.stderr);
    const out = path.join(r.root, '.dev-cycle', 'report');
    assert.ok(res.stdout.includes(path.join(out, 'index.html')));
    assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8').trim(), '*');
    const folders = fs.readdirSync(path.join(r.root, 'docs', 'features')).filter((n) => fs.existsSync(path.join(r.root, 'docs', 'features', n, 'feature.json')));
    for (const n of folders) assert.ok(fs.existsSync(path.join(out, `${n}.html`)), n);
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    assert.ok(!fs.existsSync(path.join(out, 'report.json')));
    assert.equal(r.git('status', '--porcelain').stdout.trim(), '');
  } finally { r.cleanup(); }
});

test('--json prints the model and writes report.json (AC21)', () => {
  const r = mkRepo();
  try {
    const res = runCli(['report', '--json', '--no-network'], { cwd: r.root });
    assert.equal(res.status, 0, res.stderr);
    const model = JSON.parse(res.stdout);
    for (const k of ['features', 'trend', 'tracks', 'waiting_owner', 'unconfirmed_merges']) assert.ok(Array.isArray(model[k]), k);
    const file = JSON.parse(fs.readFileSync(path.join(r.root, '.dev-cycle', 'report', 'report.json'), 'utf8'));
    assert.deepEqual(file, model);
  } finally { r.cleanup(); }
});

test('--feature writes that page plus the index; unknown feature exits 2', () => {
  const r = mkRepo();
  try {
    const name = '2026-01-05-00h-00m-xss';
    const res = runCli(['report', '--feature', name, '--no-network'], { cwd: r.root });
    assert.equal(res.status, 0, res.stderr);
    const out = path.join(r.root, '.dev-cycle', 'report');
    assert.deepEqual(fs.readdirSync(out).sort(), ['.gitignore', 'index.html', `${name}.html`].sort());
    assert.equal(runCli(['report', '--feature', 'nope', '--no-network'], { cwd: r.root }).status, 2);
    assert.equal(runCli(['report', '--all', '--feature', name], { cwd: r.root }).status, 2);
  } finally { r.cleanup(); }
});

test('two --no-network runs are byte-identical except the generated-at line', () => {
  const r = mkRepo();
  try {
    const out = path.join(r.root, 'out');
    runCli(['report', '--no-network', '--out', out], { cwd: r.root });
    const first = new Map(html(out).map((f) => [f, stripGenerated(fs.readFileSync(f, 'utf8'))]));
    runCli(['report', '--no-network', '--out', out], { cwd: r.root });
    assert.ok(first.size > 1);
    for (const [f, text] of first) assert.equal(stripGenerated(fs.readFileSync(f, 'utf8')), text, f);
  } finally { r.cleanup(); }
});

test('AC27/AC28: every generated file is escaped, CSP-first, no external resources', () => {
  const r = mkRepo();
  try {
    const out = path.join(r.root, 'out');
    assert.equal(runCli(['report', '--no-network', '--out', out], { cwd: r.root }).status, 0);
    const files = html(out);
    assert.ok(files.length > 1);
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      const low = t.toLowerCase();
      assert.ok(!low.includes('<script'), `${f} <script`);
      assert.ok(!low.includes('onerror='), `${f} onerror`);
      assert.ok(!low.includes('onload='), `${f} onload`);
      assert.ok(!low.includes('<img src=x'), `${f} img`);
      assert.ok(!/=\s*["']?\s*javascript:/i.test(t), `${f} javascript:`);
      assert.match(t, /<head>\s*<meta http-equiv="Content-Security-Policy"/, f);
      assert.ok(!/(?:src=|<link|@import|url\()[^>]*https?:\/\//i.test(t), `${f} external`);
      assert.ok(!/http:\/\//i.test(t), `${f} http`);
      for (const m of t.matchAll(/href="(https:\/\/[^"]*)"/g)) assert.match(m[1], /^https:\/\/github\.com\//, f);
    }
    const x = fs.readFileSync(path.join(out, '2026-01-05-00h-00m-xss.html'), 'utf8');
    assert.ok(x.includes('&lt;script&gt;'));
  } finally { r.cleanup(); }
});

test('AC20: fixture project, --all --no-network, under 5 s', () => {
  // fixture-based: this repo's own docs/features/ is git-ignored and absent in a fresh clone
  const proj = mkRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-report-out-'));
  try {
    const t0 = Date.now();
    const res = runCli(['report', '--all', '--no-network', '--out', out], { cwd: proj.root });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    // An existing --out dir outside .dev-cycle/ is never given a .gitignore (security W7).
    assert.ok(!fs.existsSync(path.join(out, '.gitignore')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); proj.cleanup(); }
});

test('W7: --out at the repo root or an ancestor is refused (exit 2), nothing written', () => {
  const r = mkRepo();
  try {
    for (const out of [r.root, '.', path.dirname(r.root)]) {
      const res = runCli(['report', '--no-network', '--out', out], { cwd: r.root });
      assert.equal(res.status, 2, `${out}: ${res.stderr}`);
      assert.match(res.stderr, /project root or one of its ancestors/);
    }
    assert.ok(!fs.existsSync(path.join(r.root, '.gitignore')));
    assert.ok(!fs.existsSync(path.join(r.root, 'index.html')));
    assert.equal(r.git('status', '--porcelain').stdout.trim(), '');
  } finally { r.cleanup(); }
});

test('W7: an existing --out dir keeps its .gitignore; a new one is self-ignored', () => {
  const r = mkRepo();
  try {
    const docs = path.join(r.root, 'docs');
    fs.writeFileSync(path.join(docs, '.gitignore'), 'tmp/\n');
    assert.equal(runCli(['report', '--no-network', '--out', 'docs'], { cwd: r.root }).status, 0);
    assert.equal(fs.readFileSync(path.join(docs, '.gitignore'), 'utf8'), 'tmp/\n');
    assert.ok(fs.existsSync(path.join(docs, 'index.html')));

    const fresh = path.join(r.root, 'build', 'report');
    assert.equal(runCli(['report', '--no-network', '--out', fresh], { cwd: r.root }).status, 0);
    assert.equal(fs.readFileSync(path.join(fresh, '.gitignore'), 'utf8').trim(), '*');

    const devc = path.join(r.root, '.dev-cycle', 'custom');
    fs.mkdirSync(devc, { recursive: true });
    assert.equal(runCli(['report', '--no-network', '--out', devc], { cwd: r.root }).status, 0);
    assert.equal(fs.readFileSync(path.join(devc, '.gitignore'), 'utf8').trim(), '*');
  } finally { r.cleanup(); }
});
