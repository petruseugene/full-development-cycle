import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run as runGallery, renderGallery, imageSrc } from '../plugin/scripts/lib/visual-gallery.mjs';
import { updateManifest } from '../plugin/scripts/lib/visual-core.mjs';
import { mkCtx, FIXTURES_DIR } from './helpers.mjs';

const FX = path.join(FIXTURES_DIR, 'visual-gallery', 'project');
const FEATURE = '2026-01-01-00h-00m-gallery';

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visual-gallery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(FX, root, { recursive: true });
  const featureDir = path.join(root, 'docs', 'features', FEATURE);
  return { root, featureDir, ver: path.join(featureDir, 'verification') };
}

async function gallery(p) {
  const ctx = mkCtx({ cwd: p.root });
  const code = await runGallery(['--feature', FEATURE], ctx);
  assert.equal(code, 0, ctx.err());
  return fs.readFileSync(path.join(p.ver, 'index.html'), 'utf8');
}

test('AC14: header, per-screen images, checklist and limits', async (t) => {
  const html = await gallery(project(t));
  assert.match(html, /Total time: <span class="num">87\.8 s<\/span> of <span class="num">360 s<\/span> budget/);
  assert.match(html, /teardown done \(1 steps\)/);
  assert.match(html, /chip-bad">FAILED/);
  assert.match(html, /<img src="shots\/hero\.png"/);
  assert.match(html, /<img src="\.\.\/\.\.\/\.\.\/design\/hero-ref\.png"/);
  assert.match(html, /<img src="shots\/lis\.png"/);
  for (const h of ['Check', 'Subject', 'Measured', 'Expected', 'Tolerance', 'Source', 'Result']) {
    assert.match(html, new RegExp(`<th>${h}</th>`));
  }
  assert.match(html, /12\.3 s<\/span> of <span class="num">180 s<\/span> limit/);
  assert.match(html, /75\.5 s<\/span> of <span class="num">60 s<\/span> limit/);
  assert.match(html, /friend\/hero/);
  assert.match(html, /<td class="num">0\.85<\/td>/);
  assert.match(html, /<td>vision<\/td>/);
  assert.match(html, /chip-bad">fail/);
  assert.match(html, /chip-ok">pass/);
});

test('AC14: a reference outside the project renders text and no <img>', async (t) => {
  const html = await gallery(project(t));
  assert.match(html, /reference outside project/);
  assert.equal((html.match(/<img /g) || []).length, 3); // hero shot+ref, lis shot only
  assert.doesNotMatch(html, /outside\.png/);
  assert.equal(imageSrc('/p', '/p/f/verification', '../../outside.png', { fromRoot: true }), null);
  assert.equal(imageSrc('/p', '/p/f/verification', 'https://evil.example/x.png'), null);
  assert.equal(imageSrc('/p', '/p/f/verification', '../../../../etc/passwd'), null);
});

test('AC14: a symlinked reference pointing outside the project renders no <img>', async (t) => {
  const p = project(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-gallery-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'x.png'), 'x');
  fs.symlinkSync(outside, path.join(p.root, 'docs', 'link'));
  updateManifest(p.featureDir, (m) => { m.screens.hero.reference = 'docs/link/x.png'; });
  const html = await gallery(p);
  assert.equal((html.match(/<img /g) || []).length, 2);
});

test('AC14: .gitignore is "*" and git status is clean after the gallery', async (t) => {
  const p = project(t);
  const git = (...a) => spawnSync('git', a, { cwd: p.root, encoding: 'utf8' });
  const manifestText = fs.readFileSync(path.join(p.ver, 'manifest.json'), 'utf8');
  fs.rmSync(p.ver, { recursive: true, force: true });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  // plan + gallery on a fresh verification/ folder
  fs.mkdirSync(path.join(p.ver, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(p.ver, 'manifest.json'), manifestText);
  updateManifest(p.featureDir, (m) => { m.plan = { selected: [] }; });
  await gallery(p);
  assert.equal(fs.readFileSync(path.join(p.ver, '.gitignore'), 'utf8').trim(), '*');
  const st = git('status', '--porcelain');
  assert.doesNotMatch(st.stdout, /verification/);
});

test('AC27: manifest text is escaped (XSS subject)', async (t) => {
  const p = project(t);
  updateManifest(p.featureDir, (m) => {
    m.screens.hero.title = '<script>alert(1)</script>';
    m.screens.hero.checks[0].subject = '"><img src=x onerror=alert(1)>';
  });
  const html = await gallery(p);
  assert.match(html, /&lt;svg onload&#61;alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<svg/i);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.doesNotMatch(html, /onerror=/i);
  assert.doesNotMatch(html, /onload=/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test('AC28: CSP meta first in <head>, no external URLs', async (t) => {
  const html = await gallery(project(t));
  assert.match(html, /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' file:">/);
  assert.doesNotMatch(html, /(src=|<link|@import|url\()[^>]*https?:\/\//i);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('empty manifest and missing teardown render a valid page', () => {
  const html = renderGallery({ manifest: { version: 1 }, root: '/p', featureDir: '/p/docs/features/f' });
  assert.match(html, /No screens recorded/);
  assert.match(html, /teardown not run/);
  assert.match(html, /no verdict/);
});

test('gallery is responsive: stacked below 600px, scrolling table wrapper', async (t) => {
  const html = await gallery(project(t));
  assert.match(html, /@media \(min-width:600px\)/);
  assert.match(html, /<div class="scroll"><table>/);
});

test('gallery layout: checklist spans the full row below the two images at >= 600px', async (t) => {
  const html = await gallery(project(t));
  assert.match(html, /@media \(min-width:600px\)\{\.g-row\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)\}\.g-checks\{grid-column:1\/-1\}\}/);
  assert.match(html, /<div class="g-checks"><p class="g-cap">Checklist<\/p><div class="scroll"><table>/);
  assert.doesNotMatch(html, /minmax\(0,1\.6fr\)/);
});
