import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';

const fixRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcripts');
const readFj = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'));

function mkConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cfg-'));
  fs.cpSync(fixRoot, dir, { recursive: true });
  return dir;
}
const line = (id, sidechain, ts, out) => JSON.stringify({
  type: 'assistant', isSidechain: sidechain, timestamp: ts,
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

test('AC24: history add --agent-id stores measured tokens', () => {
  const cfg = mkConfig(); const fx = mkFixture();
  try {
    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'sess-1' };
    const r = runCli(['history', 'add', '--phase', 'review', '--subagent', 's', '--status', 'DONE', '--agent-id', 'parent1', '--tokens', '~3k'], { cwd: fx.root, env });
    assert.equal(r.status, 0, r.stderr);
    const e = readFj(fx).history[0];
    assert.equal(e.estimated, false);
    assert.equal(e.agent_id, 'parent1');
    assert.ok(e.tokens.by_model);
    assert.ok(e.model_id);
    assert.ok(e.usd_est > 0);
    const t = e.tokens;
    assert.equal(e.tokens_k, Math.round(((t.input + t.output + t.cache_write) / 1000) * 10) / 10);
  } finally { fx.cleanup(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('AC25: missing agent falls back with warning; bad id exits 2', () => {
  const cfg = mkConfig(); const fx = mkFixture();
  try {
    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'sess-1' };
    const base = ['history', 'add', '--phase', 'review', '--subagent', 's', '--status', 'DONE', '--tokens', '~3k'];
    const r = runCli([...base, '--agent-id', 'missing'], { cwd: fx.root, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning/);
    const e = readFj(fx).history[0];
    assert.equal(e.tokens_k, 3);
    assert.equal(e.estimated, true);
    // review F1: the real fallback entry is counted in totals.measured
    assert.equal(readFj(fx).totals.measured.estimated_entries, 1);
    assert.equal(readFj(fx).totals.measured.measured_entries, 0);
    assert.equal(runCli([...base, '--agent-id', '../x'], { cwd: fx.root, env }).status, 2);
  } finally { fx.cleanup(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('AC26: tokens orchestrator sums main non-sidechain in window; idempotent', () => {
  const cfg = mkConfig();
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  fs.writeFileSync(path.join(cfg, 'projects/proj/sess-a.jsonl'), [
    line('a1', false, iso(-60000), 100),
    line('a2', true, iso(-50000), 7000),
    line('a3', false, iso(-3600000 * 5), 9000),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(cfg, 'projects/proj/sess-b.jsonl'), line('b1', false, iso(-30000), 200) + '\n');
  const fx = mkFixture({ featureJson: sampleFeatureJson({ started_at: iso(-3600000), sessions: ['sess-a'] }) });
  try {
    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'sess-b' };
    for (let i = 0; i < 2; i++) {
      const r = runCli(['tokens', 'orchestrator'], { cwd: fx.root, env });
      assert.equal(r.status, 0, r.stderr);
    }
    const fj = readFj(fx);
    assert.deepEqual(fj.sessions, ['sess-a', 'sess-b']);
    const orch = fj.history.filter((e) => e.phase === 'orchestrator');
    assert.equal(orch.length, 1);
    assert.equal(orch[0].tokens.output, 300);
    assert.equal(orch[0].tokens.input, 20);
    assert.equal(orch[0].executor, 'cli');
    assert.equal(orch[0].estimated, false);
  } finally { fx.cleanup(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('AC28: tokens agent prints estimate label, writes nothing; missing exits 1', () => {
  const cfg = mkConfig(); const fx = mkFixture();
  try {
    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'sess-1' };
    const before = fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8');
    const r = runCli(['tokens', 'agent', 'parent1'], { cwd: fx.root, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /estimate, prices as of/);
    assert.equal(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'), before);
    assert.equal(runCli(['tokens', 'agent', 'nope'], { cwd: fx.root, env }).status, 1);
  } finally { fx.cleanup(); fs.rmSync(cfg, { recursive: true, force: true }); }
});
