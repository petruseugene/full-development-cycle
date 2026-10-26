import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixture, runCli } from './helpers.mjs';
import { agentTimeRange } from '../plugin/scripts/lib/tokens.mjs';

const fixRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'history-times');
const readFj = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'));
const add = (fx, agent) => runCli(['history', 'add', '--phase', 'review', '--subagent', 's', '--status', 'DONE', '--agent-id', agent, '--tokens', '~3k'],
  { cwd: fx.root, env: { CLAUDE_CONFIG_DIR: fixRoot, CLAUDE_CODE_SESSION_ID: 'sess-t' } });

test('AC18: agentTimeRange returns first/last timestamp, null when missing', async () => {
  assert.deepEqual(await agentTimeRange(fixRoot, 'sess-t', 'timed'), { started_at: '2026-10-18T19:58:34.000Z', ended_at: '2026-10-18T20:14:35.000Z' });
  assert.equal(await agentTimeRange(fixRoot, 'sess-t', 'nope'), null);
});

test('AC18: history add --agent-id stores started_at/ended_at', () => {
  const fx = mkFixture();
  try {
    const r = add(fx, 'timed');
    assert.equal(r.status, 0, r.stderr);
    const e = readFj(fx).history[0];
    assert.equal(e.started_at, '2026-10-18T19:58:34.000Z');
    assert.equal(e.ended_at, '2026-10-18T20:14:35.000Z');
  } finally { fx.cleanup(); }
});

test('AC18: unknown agent id appends without times, exit 0', () => {
  const fx = mkFixture();
  try {
    const r = add(fx, 'missing');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning/);
    const e = readFj(fx).history[0];
    assert.equal(e.started_at, undefined);
    assert.equal(e.ended_at, undefined);
  } finally { fx.cleanup(); }
});

test('W6: transcript times are stored normalised; free-text and invalid stamps are dropped', async () => {
  const { normIso } = await import('../plugin/scripts/lib/tokens.mjs');
  assert.equal(normIso('2026-10-18T21:00:00+02:00'), '2026-10-18T19:00:00.000Z');
  assert.equal(normIso('Jan 1 2026 (<b>x</b>)'), null);
  assert.equal(normIso('2026-13-45T99:00:00Z'), null);
  assert.equal(normIso(42), null);
  assert.deepEqual(await agentTimeRange(fixRoot, 'sess-t', 'lenient'), { started_at: '2026-10-18T19:00:00.000Z', ended_at: '2026-10-18T22:00:00.000Z' });
  const fx = mkFixture();
  try {
    const r = add(fx, 'lenient');
    assert.equal(r.status, 0, r.stderr);
    const e = readFj(fx).history[0];
    assert.equal(e.started_at, '2026-10-18T19:00:00.000Z');
    assert.equal(e.ended_at, '2026-10-18T22:00:00.000Z');
  } finally { fx.cleanup(); }
});
