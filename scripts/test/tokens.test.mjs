import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sumUsage, sumUsageFile, agentUsage, validateAgentId, validateSessionId, findAgentTranscript, configRoot } from '../lib/tokens.mjs';
import { estimateUsd, formatUsd } from '../lib/prices.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcripts');
const parentFile = path.join(root, 'projects/proj/sess-1/subagents/agent-parent1.jsonl');

test('AC22: dedupe by message.id keeps last, skips synthetic, counts malformed', async () => {
  const r = sumUsage(fs.readFileSync(parentFile, 'utf8').split('\n'));
  assert.equal(r.input, 13);
  assert.equal(r.output, 55);
  assert.equal(r.cache_read, 1000);
  assert.equal(r.cache_write, 200);
  assert.equal(r.malformed, 1);
  assert.deepEqual(await sumUsageFile(parentFile), r);
});

test('filters: sidechain and window', () => {
  const lines = fs.readFileSync(parentFile, 'utf8').split('\n');
  assert.equal(sumUsage(lines, { filter: { sidechain: false } }).output, 0);
  const w = sumUsage(lines, { filter: { window: ['2026-10-18T10:00:05Z', '2026-10-18T10:00:06Z'] } });
  assert.equal(w.output, 5);
});

test('AC23: nested agents rolled up and listed', async () => {
  const r = await agentUsage(root, 'sess-1', 'parent1');
  assert.deepEqual(r.nested, ['child1']);
  assert.equal(r.output, 58);
  assert.equal(r.cache_read, 1100);
  assert.ok(r.by_model['claude-haiku-5-5']);
  assert.equal(await agentUsage(root, 'sess-1', 'nope'), null);
});

test('AC28: price estimate', () => {
  const e = estimateUsd({ 'claude-opus-5-5': { input: 1e6, output: 1e6, cache_read: 0, cache_write: 0, cache_write_1h: 0 } });
  assert.equal(e.usd_est, 24);
  const u = estimateUsd({ 'mystery-1': { input: 5, output: 5, cache_read: 0, cache_write: 0, cache_write_1h: 0 } });
  assert.equal(u.usd_est, 0);
  assert.deepEqual(u.usd_unpriced, ['mystery-1']);
  assert.match(formatUsd(24), /estimate, prices as of/);
});

test('cache write pricing 1.25x / 2x, longest prefix wins', () => {
  const e = estimateUsd({ 'claude-opus-5-5-x': { input: 0, output: 0, cache_read: 0, cache_write: 2e6, cache_write_1h: 1e6 } });
  assert.equal(e.usd_est, 4 * 1.25 + 4 * 2);
});

test('id validation and locator', () => {
  assert.throws(() => validateAgentId('../x'), /invalid agent id/);
  assert.throws(() => validateSessionId('../x'), /invalid session id/);
  assert.ok(findAgentTranscript(root, 'sess-1', 'parent1'));
  assert.equal(configRoot({ CLAUDE_CONFIG_DIR: '/x' }), '/x');
});

test('security S6: __proto__/constructor model ids stay data; usage fields coerced to numbers', () => {
  const line = (id, model, usage) => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
  const r = sumUsage([
    line('a', '__proto__', { input_tokens: 5, output_tokens: 1 }),
    line('b', 'constructor', { input_tokens: '7', output_tokens: 'x', cache_read_input_tokens: null }),
    line('c', 'claude-x', { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: Infinity }),
  ]);
  assert.equal(({}).input, undefined, 'Object.prototype not polluted');
  assert.equal(Object.getPrototypeOf(r.by_model), Object.prototype);
  assert.ok(Object.hasOwn(r.by_model, '__proto__'));
  assert.equal(r.by_model.constructor.input, 7);
  assert.equal(r.input, 13);
  assert.equal(r.output, 3);
  assert.equal(typeof r.input, 'number');
  assert.equal(r.cache_write, 0);
  assert.deepEqual(Object.keys(r.by_model), ['__proto__', 'constructor', 'claude-x']);
  // round-trips through JSON as own data
  assert.equal(JSON.parse(JSON.stringify(r.by_model))['__proto__'].input, 5);
});
