import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Pins the lean quick/bugfix fast path (lean-quick spec AC1-AC8, AC11). Read-only over the repo tree.
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const size = (p) => fs.statSync(path.join(ROOT, p)).size;
const QUICK = 'skills/orchestrator/references/quick.md';
const flat = (t) => t.replace(/\s+/g, ' ');

test('AC1: quick.md exists, fits the byte budget and carries the required literals', () => {
  assert.ok(fs.existsSync(path.join(ROOT, QUICK)), 'quick.md missing');
  assert.ok(size(QUICK) <= 8192, `${size(QUICK)} bytes`);
  const t = rd(QUICK);
  for (const k of [
    'check --scope tree-wide --record', 'review snapshot', 'review diff --since-cycle', 'history add',
    '--agent-id', 'report --feature', 'dod', '! DOD-GATE FAILED:', 'ship --subject', '--release',
    '> TRACK:', '> SKIP:', 'context --touches', 'Request (verbatim):', 'post-merge',
  ]) assert.ok(t.includes(k), k);
});

test('AC2: quick.md carries the four dispatch-template strings', () => {
  const f = flat(rd(QUICK));
  assert.ok(f.includes('Read `<root>/skills/<x>/SKILL.md`'));
  assert.ok(f.includes('`${CLAUDE_PLUGIN_ROOT}` means `<root>`'));
  assert.ok(f.includes('`references/…` paths are relative to `<root>/skills/<x>/`'));
  assert.ok(f.includes('Do not call the Skill tool for dev-cycle skills'));
});

test('AC3: quick.md pins explicit implementer model: never omitted or inherit, override -> haiku -> sonnet', () => {
  const f = flat(rd(QUICK));
  assert.match(f, /never omitted/i);
  assert.match(f, /never `?inherit`?/i);
  assert.match(f, /feature\.json\.models/);
  const i = [f.search(/models\[/), f.indexOf('haiku'), f.lastIndexOf('sonnet', f.indexOf('haiku') + 400)];
  assert.ok(i.every((x) => x >= 0), String(i));
  const m = f.match(/models\[[^\n]*?haiku[^\n]*?sonnet/);
  assert.ok(m, 'override, then haiku, then sonnet in one resolution sentence');
  assert.match(f, /auto-tester/);
  assert.match(f, /reviewer/i);
});

// Glob matcher (case-insensitive). "**/" matches zero or more leading dirs; a "**/<segment>" glob with no
// further slash matches when ANY path segment matches <segment>; otherwise "**" = anything, "*" = within a segment.
const segRe = (g) => new RegExp('^' + g.replace(/[.+^$|()[\]{}?]/g, '\\$&').replace(/\*/g, '[^/]*') + '$', 'i');
const globRe = (g) => {
  const m = g.match(/^\*\*\/([^/]+)$/);
  if (m) { const r = segRe(m[1]); return { test: (p) => p.split('/').some((x) => r.test(x)) }; }
  return new RegExp('^' + g.replace(/[.+^$|()[\]{}?]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*') + '$', 'i');
};
const ticks = (line) => [...line.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
function sensitiveLists() {
  const sec = rd(QUICK).split(/^## /m).find((x) => /^\d*\.?\s*Sensitive/i.test(x));
  assert.ok(sec, 'sensitive-change section');
  const pathLine = sec.split('\n').find((l) => /a path matches/i.test(l));
  const wordLine = sec.split('\n').find((l) => /request text contains/i.test(l));
  assert.ok(pathLine && wordLine, 'path and word bullets');
  return { globs: ticks(pathLine), words: ticks(wordLine), sec };
}

test('AC4: sensitive-change section lists globs and words (separately), git commands and the MODEL line', () => {
  const { globs, words, sec } = sensitiveLists();
  for (const g of ['**/*auth*', '**/*secret*', '**/*credential*', '**/*passw*', '**/.env*', '**/*guard*',
    '**/hooks/**', '**/.husky/**', '**/*telemetry*', '**/*analytics*', '**/*exec*', '**/*shell*',
    '**/*security*', '**/*permission*', '**/*approval*', '**/*safety*', '**/*loopback*', '**/*token*', '**/api/**', '**/agent/**',
    'SECURITY*', 'PRIVACY*']) assert.ok(globs.includes(g), 'glob ' + g);
  for (const w of ['auth', 'secret', 'credential', 'password', 'token', 'telemetry', 'privacy', 'git-guard', 'hook',
    'security', 'permission', 'vulnerab', 'inject', 'api key']) assert.ok(words.includes(w), 'word ' + w);
  assert.ok(sec.includes('git status --porcelain --untracked-files=all'));
  assert.match(sec, /git diff --name-only/);
  assert.match(sec, /merge-base/);
  assert.ok(sec.includes('> MODEL: dev-cycle:code-reviewer=<model> — <reason>'));
  for (const r of ['quick', 'sensitive:', 'override']) assert.ok(sec.includes(r), r);
});

test('AC9: listed globs match this repo\'s real security-relevant files and not benign ones', () => {
  const { globs } = sensitiveLists();
  const res = globs.map(globRe);
  for (const p of ['scripts/git-guard.mjs', 'hooks/hooks.json', 'scripts/lib/tokens.mjs', 'scripts/lib/recipe-safety.mjs',
    'dashboard/lib/agent/path-safety.ts', 'dashboard/lib/agent/loopback.ts', 'dashboard/app/api/agent/approvals/route.ts',
    'dashboard/components/chat/ApprovalCard.tsx', 'skills/security-reviewer/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), 'listed file missing (renamed?): ' + p);
    assert.ok(res.some((r) => r.test(p)), 'not matched: ' + p);
  }
  for (const p of ['README.md', 'skills/orchestrator/references/dashboard-format.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), 'file missing: ' + p);
    assert.ok(!res.some((r) => r.test(p)), 'false positive: ' + p);
  }
});

test('AC5: quick.md has the bugfix deltas', () => {
  const t = rd(QUICK);
  assert.ok(t.includes('--flow bugfix'));
  assert.ok(t.includes('fix/'));
  assert.match(t, /root cause/i);
});

test('AC6: orchestrator SKILL.md branches to quick.md inside Required reading, before item 2', () => {
  const o = rd('skills/orchestrator/SKILL.md');
  const start = o.indexOf('## Required reading');
  assert.ok(start >= 0);
  const sec = o.slice(start);
  const q = sec.indexOf('references/quick.md');
  const two = sec.search(/^2\./m);
  assert.ok(q >= 0, 'no quick.md reference in Required reading');
  assert.ok(two >= 0 && q < two, 'quick.md must precede item 2');
  const pre = sec.slice(0, two);
  assert.match(pre, /bugfix/);
  assert.match(pre, /quick/);
  assert.match(pre, /hotfix/i);
  assert.match(pre, /escalat/i);
  assert.ok(o.includes('the five rules'));
  assert.ok(!o.includes('the four rules'));
});

test('AC7: lifecycle model resolution has the quick reviewer rule between doc task and registry default', () => {
  const l = rd('skills/playbook/references/lifecycle.md');
  const mr = l.slice(l.indexOf('### Model resolution'));
  const a = mr.indexOf('doc task');
  const b = mr.indexOf('registry default');
  assert.ok(a >= 0 && b > a);
  const mid = mr.slice(a, b);
  for (const k of ['code-reviewer', 'quick', 'bugfix', 'sonnet', 'quick.md']) assert.ok(mid.includes(k), k);
});

test('AC8: code-reviewer states the request text is the acceptance source on quick/bugfix', () => {
  const t = rd('skills/code-reviewer/SKILL.md');
  assert.ok(t.includes('Request (verbatim):'));
  assert.match(t, /quick/);
  assert.match(t, /bugfix/);
  assert.match(t, /5[–-]6/);
});

test('AC11: size caps hold', () => {
  assert.ok(size('skills/orchestrator/SKILL.md') <= 18765, `SKILL.md ${size('skills/orchestrator/SKILL.md')}`);
  assert.ok(size('skills/playbook/references/lifecycle.md') <= 29105, `lifecycle ${size('skills/playbook/references/lifecycle.md')}`);
});

test('AC12: lifecycle §1a quick list is a short pointer to quick.md', () => {
  const l = rd('skills/playbook/references/lifecycle.md');
  const line = l.split('\n').filter((s) => s.startsWith('- **quick**'));
  assert.equal(line.length, 1);
  assert.ok(line[0].includes('skills/orchestrator/references/quick.md'));
  const i = l.indexOf('- **quick**');
  const after = l.slice(i).split('\n');
  assert.ok(!after[1].startsWith('  -'), 'quick bullet must not carry sub-bullets');
});

test('AC13: README drops the stale --track claim and mentions the fast path; CHANGELOG has Unreleased entry', () => {
  const r = rd('README.md');
  assert.ok(!r.includes('`--track` is required for `feature`'));
  assert.match(r, /references\/quick\.md/);
  assert.match(r, /sonnet/);
  const c = rd('CHANGELOG.md');
  assert.match(c.split('\n').filter((l) => l.startsWith('## '))[0], /^## \[(Unreleased|\d+\.\d+\.\d+)\]/);
  // release-proof: the entry may live in any Unreleased or x.y.z section
  const secs = c.split(/^## /m).slice(1).filter((x) => /^\[(Unreleased|\d+\.\d+\.\d+)\]/.test(x));
  assert.ok(secs.some((x) => /quick\.md|fast path/i.test(x) && /quick-path\.test/.test(x)), 'no section mentions the quick fast path');
});

test('AC14: quick.md ends with a Verify cost note', () => {
  const t = rd(QUICK).trimEnd();
  const i = t.lastIndexOf('## Verify cost');
  assert.ok(i >= 0);
  const note = t.slice(i);
  assert.ok(note.includes('report --feature'));
  assert.ok(note.includes('usd_est'));
  assert.ok(note.includes('1.35'));
});
