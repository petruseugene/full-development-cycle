import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli } from './helpers.mjs';
import { parseDuration, parseTokens, isValidPhase, appendHistory } from '../plugin/scripts/lib/history.mjs';

const readFj = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'));

test('AC9: history add parses duration/tokens, defaults model, ISO ts', () => {
  const fx = mkFixture();
  try {
    const r = runCli(['history', 'add', '--phase', 'review', '--subagent', 'code-reviewer', '--status', 'APPROVED',
      '--duration', '2m 14s', '--tokens', '~1.1k'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const fj = readFj(fx);
    assert.equal(fj.history.length, 1);
    const e = fj.history[0];
    assert.equal(e.duration_s, 134);
    assert.equal(e.tokens_k, 1.1);
    assert.equal(e.model, 'inherit');
    assert.ok(!Number.isNaN(Date.parse(e.ts)));
    assert.equal(fj.totals.by_subagent['code-reviewer'].approved, 1);
  } finally { fx.cleanup(); }
});

test('AC9: invalid phase exits 2 and appends nothing', () => {
  const fx = mkFixture();
  try {
    const before = fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8');
    const r = runCli(['history', 'add', '--phase', 'reviewing', '--subagent', 'x', '--status', 'DONE'], { cwd: fx.root });
    assert.equal(r.status, 2);
    assert.equal(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'), before);
  } finally { fx.cleanup(); }
});

test('history add: bad duration/tokens/verb exit 2; optional fields stored', () => {
  const fx = mkFixture();
  try {
    const base = ['history', 'add', '--phase', 'spec', '--subagent', 's', '--status', 'DONE'];
    assert.equal(runCli([...base, '--duration', 'soon'], { cwd: fx.root }).status, 2);
    assert.equal(runCli([...base, '--tokens', 'lots'], { cwd: fx.root }).status, 2);
    assert.equal(runCli(['history', 'del', '--phase', 'spec', '--subagent', 's', '--status', 'DONE'], { cwd: fx.root }).status, 2);
    assert.equal(readFj(fx).history.length, 0);
    const r = runCli([...base, '--model', 'opus', '--summary', 'sum', '--concerns', 'c', '--json'], { cwd: fx.root });
    assert.equal(r.status, 0);
    const e = readFj(fx).history[0];
    assert.deepEqual([e.model, e.summary, e.concerns], ['opus', 'sum', 'c']);
  } finally { fx.cleanup(); }
});

test('phase grammar', () => {
  for (const p of ['discovery', 'architecture', 'spec', 'wireframe', 'plan', 'git', 'implement', 'implement.task=3',
    'implement.area=skills', 'static-check', 'review', 'auto-test', 'visual-test', 'a11y', 'deps-audit', 'security',
    'gate.content', 'interview', 'conflict', 'release', 'migrate', 'migrate.task=4', 'cherry-pick', 'orchestrator']) assert.ok(isValidPhase(p), p);
  for (const p of ['', 'reviewing', 'implement.task=', 'implement.task=x', 'gate.', 'gate.Bad Name', 'implement.area=Bad', 'migrate.task=', 'migrate.area=x']) {
    assert.ok(!isValidPhase(p), p);
  }
});

test('parseDuration / parseTokens', () => {
  assert.equal(parseDuration('52'), 52);
  assert.equal(parseDuration('52s'), 52);
  assert.equal(parseDuration('2m 14s'), 134);
  assert.equal(parseDuration('2m'), 120);
  assert.throws(() => parseDuration(''));
  assert.throws(() => parseDuration('abc'));
  assert.equal(parseTokens('3.2'), 3.2);
  assert.equal(parseTokens('3.2k'), 3.2);
  assert.equal(parseTokens('~3.2k'), 3.2);
  assert.throws(() => parseTokens('~k'));
});

test('appendHistory rejects invalid phase without writing', () => {
  const fx = mkFixture();
  try {
    assert.throws(() => appendHistory(fx.featureDir, { phase: 'nope', subagent: 's', status: 'DONE' }));
    assert.equal(readFj(fx).history.length, 0);
  } finally { fx.cleanup(); }
});

test('appendHistory passes through measured-token keys unchanged', () => {
  const fx = mkFixture();
  try {
    const extra = {
      executor: 'cli', agent_id: 'a1', tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
      estimated: true, model_id: 'claude-x', usd_est: 0.5, usd_unpriced: false,
    };
    const e = appendHistory(fx.featureDir, { phase: 'orchestrator', subagent: 'orchestrator', status: 'DONE', ...extra });
    assert.deepEqual({ ...e, ts: undefined, phase: undefined, subagent: undefined, status: undefined, model: undefined },
      { ...extra, ts: undefined, phase: undefined, subagent: undefined, status: undefined, model: undefined });
    const fj = JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'));
    assert.deepEqual(fj.history.at(-1).tokens, extra.tokens);
    assert.equal(fj.totals.measured.measured_entries, 1);
  } finally { fx.cleanup(); }
});
