import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson, DEFAULT_FEATURE } from './helpers.mjs';
import { buildTimeline } from '../plugin/scripts/lib/report-timeline.mjs';
import { computeTotals } from '../plugin/scripts/lib/totals.mjs';

const h = (phase, status, ts, extra = {}) => ({ ts, phase, subagent: 'x', status, ...extra });
const T = (n) => `2026-01-01T00:0${n}:00Z`;

function fixture(history) {
  return mkFixture({ featureJson: sampleFeatureJson({ flow: 'bugfix', track: 'quick', auto_tests: false, history }) });
}
const concern = h('implement', 'DONE_WITH_CONCERNS', T(1), { concerns: 'flaky lint on legacy file' });

test('concern then later APPROVED review passes and reports resolved', () => {
  const fx = fixture([concern, h('static-check', 'PASSED', T(2)), h('review', 'APPROVED', T(3))]);
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /implement: resolved by review 2026-01-01T00:03:00Z/);
  } finally { fx.cleanup(); }
});

test('review APPROVED before the concern does not resolve it', () => {
  const fx = fixture([h('review', 'APPROVED', T(0)), concern, h('static-check', 'PASSED', T(2))]);
  try {
    assert.equal(runCli(['dod'], { cwd: fx.root }).status, 1);
  } finally { fx.cleanup(); }
});

test('concern without later review fails and names the concern and resolve command', () => {
  const fx = fixture([concern, h('static-check', 'PASSED', T(2))]);
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /DOD-GATE FAILED: implement last status = DONE_WITH_CONCERNS/);
    assert.match(r.stdout, /concern: flaky lint on legacy file; resolve with: history resolve --phase implement --by review\|owner\|fix/);
  } finally { fx.cleanup(); }
});

test('history resolve writes RESOLVED, dod passes, no totals or timeline run', () => {
  const fx = fixture([concern, h('static-check', 'PASSED', T(2)), h('review', 'CHANGES_REQUIRED', T(3))]);
  try {
    const hist = [...JSON.parse(fs.readFileSync(path.join(fx.root, 'docs/features', DEFAULT_FEATURE, 'feature.json'), 'utf8')).history];
    assert.equal(hist.length, 3);
    // review is not approved, so the gate still fails before resolve
    const r1 = runCli(['history', 'resolve', '--phase', 'implement', '--by', 'owner', '--note', 'accepted\nby owner'], { cwd: fx.root });
    assert.equal(r1.status, 0, r1.stderr);
    const fj = JSON.parse(fs.readFileSync(path.join(fx.root, 'docs/features', DEFAULT_FEATURE, 'feature.json'), 'utf8'));
    const e = fj.history.at(-1);
    assert.equal(e.status, 'RESOLVED');
    assert.equal(e.subagent, 'orchestrator');
    assert.equal(e.summary, 'accepted by owner');
    assert.equal(e.tokens_k, undefined);
    assert.equal(fj.totals.by_subagent.orchestrator, undefined);
    const tl = buildTimeline(fj.history);
    assert.ok(!tl.timeline.some((r) => r.status === 'RESOLVED'));
    assert.equal(tl.fix_cycles.length, 0);
    assert.ok(!computeTotals(fj.history).by_subagent.orchestrator);
    const d = runCli(['dod'], { cwd: fx.root });
    assert.match(d.stdout, /FAILED: review/); // implement now passes; next gate is review
    assert.doesNotMatch(d.stdout, /FAILED: implement/);
  } finally { fx.cleanup(); }
});

test('history resolve rejects non-implement phase, non-concern status, bad --by, empty note', () => {
  const fx = fixture([h('implement', 'DONE', T(1)), h('review', 'DONE_WITH_CONCERNS', T(2))]);
  try {
    const bad = (args) => runCli(['history', 'resolve', ...args], { cwd: fx.root });
    assert.equal(bad(['--phase', 'review', '--by', 'owner', '--note', 'x']).status, 2);
    const nc = bad(['--phase', 'implement', '--by', 'owner', '--note', 'x']);
    assert.equal(nc.status, 2);
    assert.match(nc.stderr, /only DONE_WITH_CONCERNS/);
    assert.equal(bad(['--phase', 'implement', '--by', 'me', '--note', 'x']).status, 2);
    assert.equal(bad(['--phase', 'implement', '--by', 'fix']).status, 2);
  } finally { fx.cleanup(); }
});

test('feature resume shows the resolved note for the implement gate', () => {
  const fx = fixture([concern, h('static-check', 'PASSED', T(2)), h('review', 'APPROVED', T(3))]);
  try {
    const r = runCli(['feature', 'resume'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /implement: DONE_WITH_CONCERNS \(resolved by review/);
  } finally { fx.cleanup(); }
});

// --- auto-tester gap tests ---
const PLAN2 = '---\nstatus: IN PROGRESS\n---\n# Plan\n\n## Tasks\n- [DONE] **Task 1** (backend): a\n- [DONE] **Task 2** (backend): b\n\n## Task details\n';

test('lite track: concern on implement.area=X resolved by later APPROVED review', () => {
  const mk = (extra) => mkFixture({ featureJson: sampleFeatureJson({ flow: 'feature', track: 'lite', auto_tests: false, areas: [{ name: 'skills' }],
    history: [h('spec', 'DONE', T(0)), h('implement.area=skills', 'DONE_WITH_CONCERNS', T(1), { concerns: 'c' }), h('static-check', 'PASSED', T(2)), ...extra] }) });
  const ok = mk([h('review', 'APPROVED', T(3))]);
  try {
    const r = runCli(['dod'], { cwd: ok.root });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /implement\.area=skills: resolved by review/);
  } finally { ok.cleanup(); }
  const bad = mk([]);
  try {
    const r = runCli(['dod'], { cwd: bad.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /resolve with: history resolve --phase implement\.area=skills /);
  } finally { bad.cleanup(); }
});

test('concern, CHANGES_REQUIRED, then APPROVED passes; CHANGES_REQUIRED alone fails', () => {
  const fx = fixture([concern, h('static-check', 'PASSED', T(2)), h('review', 'CHANGES_REQUIRED', T(3)), h('review', 'APPROVED', T(4))]);
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /resolved by review 2026-01-01T00:04:00Z/);
  } finally { fx.cleanup(); }
  const fx2 = fixture([concern, h('static-check', 'PASSED', T(2)), h('review', 'CHANGES_REQUIRED', T(3))]);
  try { assert.equal(runCli(['dod'], { cwd: fx2.root }).status, 1); } finally { fx2.cleanup(); }
});

test('a later non-concern implement entry supersedes; a new concern after APPROVED is not resolved by the older review', () => {
  const fx = fixture([concern, h('review', 'APPROVED', T(2)), h('implement', 'DONE_WITH_CONCERNS', T(3), { concerns: 'again' }), h('static-check', 'PASSED', T(4))]);
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /concern: again;/);
  } finally { fx.cleanup(); }
});

test('RESOLVED on a non-implement gate does not pass', () => {
  const fx = fixture([h('implement', 'DONE', T(1)), h('static-check', 'PASSED', T(2)), h('review', 'DONE_WITH_CONCERNS', T(3)), h('review', 'RESOLVED', T(4), { resolved_by: 'owner' })]);
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAILED: review last status = RESOLVED/);
  } finally { fx.cleanup(); }
});

test('APPROVED review does not resolve a DONE_WITH_CONCERNS on a non-implement gate (static-check)', () => {
  const fx = fixture([h('implement', 'DONE', T(1)), h('static-check', 'DONE_WITH_CONCERNS', T(2)), h('review', 'APPROVED', T(3))]);
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAILED: static-check/);
  } finally { fx.cleanup(); }
});

test('multiple tasks: one resolved by review, other unresolved concern after review still fails and names its task', () => {
  const base = (hist) => mkFixture({ featureJson: sampleFeatureJson({ auto_tests: false, history: hist }), files: { 'plan.md': PLAN2 } });
  const pre = [h('spec', 'DONE', T(0)), h('plan', 'DONE', T(0)), h('implement.task=1', 'DONE_WITH_CONCERNS', T(1), { concerns: 'c1' }), h('implement.task=2', 'DONE', T(1)), h('static-check', 'PASSED', T(2))];
  const fx = base([...pre, h('review', 'APPROVED', T(3)), h('implement.task=2', 'DONE_WITH_CONCERNS', T(4), { concerns: 'c2' })]);
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAILED: implement\.task=2 last status = DONE_WITH_CONCERNS/);
    assert.match(r.stdout, /history resolve --phase implement\.task=2 /);
    assert.doesNotMatch(r.stdout, /FAILED: implement\.task=1/);
  } finally { fx.cleanup(); }
  const fx2 = base([...pre, h('review', 'APPROVED', T(3))]);
  try { assert.equal(runCli(['dod'], { cwd: fx2.root }).status, 0); } finally { fx2.cleanup(); }
});

test('history resolve works on implement.task=N and implement.area=X; rejects malformed implement-like phases', () => {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ flow: 'feature', track: 'lite', areas: [{ name: 'skills' }],
    history: [h('implement.area=skills', 'DONE_WITH_CONCERNS', T(1), { concerns: 'c' })] }) });
  try {
    const run = (p) => runCli(['history', 'resolve', '--phase', p, '--by', 'fix', '--note', 'n'], { cwd: fx.root });
    assert.equal(run('implement.area=skills').status, 0);
    assert.equal(run('implementx').status, 2);
    assert.equal(run('implement.task=').status, 2);
    assert.equal(run('static-check').status, 2);
  } finally { fx.cleanup(); }
});

test('dod --json carries failed.hint for unresolved concern and note for resolved', () => {
  const fx = fixture([concern, h('static-check', 'PASSED', T(2))]);
  try {
    const r = runCli(['dod', '--json'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /history resolve --phase implement/);
  } finally { fx.cleanup(); }
});
