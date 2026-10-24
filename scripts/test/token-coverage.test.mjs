import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { isDispatchedEntry, tokenCoverage, tokenCoverageLine } from '../lib/token-coverage.mjs';
import { validateProfile } from '../lib/profile.mjs';

const MSG = 'no --agent-id: tokens are a self-estimate; pass --agent-id <id> for measured tokens';
const REVIEW = ['history', 'add', '--phase', 'review', '--subagent', 'dev-cycle:code-reviewer', '--status', 'APPROVED', '--tokens', '4k'];
const hist = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8')).history;

test('AC1: missing --agent-id warns on stderr, still appends, exit 0', () => {
  const fx = mkFixture();
  try {
    const before = hist(fx).length;
    const r = runCli(REVIEW, { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(MSG), r.stderr);
    assert.equal(hist(fx).length, before + 1);
  } finally { fx.cleanup(); }
});

test('AC2: bookkeeping entries print no --agent-id warning', () => {
  const fx = mkFixture();
  try {
    const cases = [
      ['git', 'cli'], ['gate.lint', 'gate'], ['spec', 'orchestrator'], ['conflict', 'orchestrator'],
      ['owner.task=3', 'owner'], ['interview', 'dev-cycle:x'],
    ];
    for (const [phase, sub] of cases) {
      const r = runCli(['history', 'add', '--phase', phase, '--subagent', sub, '--status', 'DONE'], { cwd: fx.root });
      assert.equal(r.status, 0, `${phase}: ${r.stderr}`);
      assert.ok(!r.stderr.includes('no --agent-id'), `${phase}: ${r.stderr}`);
    }
  } finally { fx.cleanup(); }
});

test('AC3: with --agent-id and no transcript only the transcript warning prints', () => {
  const fx = mkFixture();
  try {
    const r = runCli(['history', 'add', '--phase', 'implement', '--subagent', 'dev-cycle:backend-dev', '--status', 'DONE', '--tokens', '2k', '--agent-id', 'a1b2c3'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /transcript for agent 'a1b2c3' not found/);
    assert.ok(!r.stderr.includes('no --agent-id'));
  } finally { fx.cleanup(); }
});

test('AC4: strict_tokens makes the missing --agent-id an exit-2 error and writes nothing', () => {
  const fx = mkFixture();
  try {
    fx.write('.dev-cycle/project.json', JSON.stringify({ strict_tokens: true }));
    const before = hist(fx).length;
    const r = runCli(REVIEW, { cwd: fx.root });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(MSG) && r.stderr.includes('(strict_tokens)'), r.stderr);
    assert.equal(hist(fx).length, before);
    const ok = runCli(['history', 'add', '--phase', 'git', '--subagent', 'cli', '--status', 'DONE'], { cwd: fx.root });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(hist(fx).length, before + 1);
  } finally { fx.cleanup(); }
});

test('AC5: profile validates strict_tokens as a boolean', () => {
  assert.deepEqual(validateProfile({ strict_tokens: false }), { errors: [], warnings: [] });
  assert.deepEqual(validateProfile({ strict_tokens: 'yes' }).errors, ['strict_tokens must be a boolean']);
  const fx = mkFixture();
  try {
    fx.write('.dev-cycle/project.json', JSON.stringify({ strict_tokens: 'yes' }));
    const r = runCli(['profile', 'validate'], { cwd: fx.root });
    assert.equal(r.status, 2);
    assert.ok((r.stderr + r.stdout).includes('strict_tokens must be a boolean'));
  } finally { fx.cleanup(); }
});

test('AC6: tokenCoverage counts only dispatched entries', () => {
  const history = [
    { phase: 'implement', subagent: 'dev-cycle:backend-dev', status: 'DONE', tokens: { input: 1 } },
    { phase: 'review', subagent: 'dev-cycle:code-reviewer', status: 'APPROVED', tokens_k: 3 },
    { phase: 'review', subagent: 'dev-cycle:code-reviewer', status: 'APPROVED' },
    { phase: 'orchestrator', subagent: 'x', status: 'DONE', tokens: { input: 5 } },
    { phase: 'commit', subagent: 'git-agent', executor: 'cli', status: 'DONE' },
    { phase: 'gate.lint', subagent: 'gate', status: 'PASSED' },
  ];
  assert.deepEqual(tokenCoverage(history), { measured: 1, estimated: 2 });
  assert.equal(tokenCoverageLine(history), 'tokens: 1 measured / 2 estimated entries');
  assert.deepEqual(tokenCoverage(undefined), { measured: 0, estimated: 0 });
  assert.equal(isDispatchedEntry({ phase: 'plan', subagent: 'dev-cycle:plan-writer' }), true);
});

test('AC7: dod prints the tokens line after the verdict line; --json carries tokens', () => {
  const dispatched = { ts: '2026-01-01T00:00:00Z', phase: 'spec', subagent: 'dev-cycle:spec-writer', status: 'DONE', tokens: { input: 1, output: 1 } };
  const fx = mkFixture({ featureJson: sampleFeatureJson({ auto_tests: false, history: [dispatched] }) });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    const l = r.stdout.trimEnd().split('\n');
    assert.match(l[0], /^! DOD-GATE FAILED: /);
    assert.equal(l[1], 'tokens: 1 measured / 0 estimated entries');
    const j = runCli(['dod', '--json'], { cwd: fx.root });
    assert.deepEqual(JSON.parse(j.stdout).tokens, { measured: 1, estimated: 0 });
  } finally { fx.cleanup(); }
});

test('edge: strict_tokens rejection leaves feature.json byte-identical', () => {
  const fx = mkFixture();
  try {
    fx.write('.dev-cycle/project.json', JSON.stringify({ strict_tokens: true }));
    const file = path.join(fx.featureDir, 'feature.json');
    const before = fs.readFileSync(file);
    const r = runCli(REVIEW, { cwd: fx.root });
    assert.equal(r.status, 2);
    assert.ok(before.equals(fs.readFileSync(file)));
  } finally { fx.cleanup(); }
});

test('F1: an unparsable project.json does not make history add fail; it warns as usual', () => {
  const fx = mkFixture();
  try {
    fx.write('.dev-cycle/project.json', '{ not json');
    const before = hist(fx).length;
    const r = runCli(REVIEW, { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(MSG), r.stderr);
    assert.equal(hist(fx).length, before + 1);
  } finally { fx.cleanup(); }
});
