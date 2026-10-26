import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readFeatureJson, updateFeatureJson, writeFeatureJson, featureJsonPath,
} from '../plugin/scripts/lib/feature-json.mjs';
import { UsageError } from '../plugin/scripts/lib/core.mjs';
import { mkFixture, sampleFeatureJson, leftoverTempFiles } from './helpers.mjs';

function withUnknownKeys() {
  return sampleFeatureJson({
    notes: 'free text with "quotes" and unicode — ✓',
    cycle_counts: { 1: 2, 3: 0 },
    custom: { nested: [1, { a: null }], flag: false },
    history: [
      { ts: '2026-01-01T00:00', phase: 'spec', subagent: 'spec-writer', model: 'opus', status: 'DONE', duration_s: 10, tokens_k: 1, message: 'entry-level extra' },
    ],
  });
}

test('AC4: unknown keys are deep-equal after a write; no temp file left', (t) => {
  const original = withUnknownKeys();
  const fx = mkFixture({ featureJson: original });
  t.after(() => fx.cleanup());

  updateFeatureJson(fx.featureDir, (fj) => {
    fj.history.push({ ts: '2026-01-01T00:05', phase: 'plan', subagent: 'plan-writer', status: 'DONE' });
  });

  const after = readFeatureJson(fx.featureDir);
  assert.deepEqual(after.notes, original.notes);
  assert.deepEqual(after.cycle_counts, original.cycle_counts);
  assert.deepEqual(after.custom, original.custom);
  assert.deepEqual(after.history[0], original.history[0]);
  assert.equal(after.history[0].message, 'entry-level extra');
  assert.equal(after.history.length, 2);
  assert.deepEqual(leftoverTempFiles(fx.featureDir), []);
});

test('write format: 2-space JSON with trailing newline; key order kept', (t) => {
  const fx = mkFixture({ featureJson: withUnknownKeys() });
  t.after(() => fx.cleanup());
  const file = featureJsonPath(fx.featureDir);
  const keysBefore = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));

  updateFeatureJson(fx.featureDir, () => {});
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + '\n');
  assert.deepEqual(Object.keys(JSON.parse(text)), keysBefore);
});

test('updateFeatureJson adds totals when absent and accepts a returned object', (t) => {
  const fj = sampleFeatureJson({ history: [{ phase: 'git', subagent: 'git-agent', status: 'DONE', duration_s: 5 }] });
  delete fj.totals;
  const fx = mkFixture({ featureJson: fj });
  t.after(() => fx.cleanup());

  const written = updateFeatureJson(fx.featureDir, (obj) => ({ ...obj, extra: 1 }));
  assert.equal(written.extra, 1);
  assert.deepEqual(readFeatureJson(fx.featureDir).totals.by_subagent['git-agent'].calls, 1);
});

test('updateFeatureJson re-reads the file each call (no stale cache)', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  updateFeatureJson(fx.featureDir, (fj) => { fj.a = 1; });
  // External writer changes the file between CLI calls.
  const file = featureJsonPath(fx.featureDir);
  const ext = JSON.parse(fs.readFileSync(file, 'utf8'));
  ext.external = true;
  fs.writeFileSync(file, JSON.stringify(ext));
  updateFeatureJson(fx.featureDir, (fj) => { fj.b = 2; });
  const after = readFeatureJson(fx.featureDir);
  assert.equal(after.a, 1);
  assert.equal(after.b, 2);
  assert.equal(after.external, true);
});

test('missing or invalid feature.json is a UsageError and the file is untouched', (t) => {
  const fx = mkFixture({ featureJson: null });
  t.after(() => fx.cleanup());
  assert.throws(() => readFeatureJson(fx.featureDir), UsageError);

  const file = featureJsonPath(fx.featureDir);
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => updateFeatureJson(fx.featureDir, () => {}), UsageError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.writeFileSync(file, '[]');
  assert.throws(() => readFeatureJson(fx.featureDir), UsageError);
  assert.deepEqual(leftoverTempFiles(fx.featureDir), []);
});

test('a throwing mutator writes nothing', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const file = featureJsonPath(fx.featureDir);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => updateFeatureJson(fx.featureDir, () => { throw new UsageError('nope'); }), UsageError);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

const ZERO_MEASURED = { input: 0, output: 0, cache_read: 0, cache_write: 0, billable_k: 0, usd_est: 0, measured_entries: 0, estimated_entries: 0 };

test('writeFeatureJson creates a file with computed totals', (t) => {
  const fx = mkFixture({ featureJson: null });
  t.after(() => fx.cleanup());
  const dir = path.join(fx.featuresDir, 'new');
  fs.mkdirSync(dir);
  writeFeatureJson(dir, { feature_slug: 'new', history: [] });
  assert.deepEqual(readFeatureJson(dir), {
    feature_slug: 'new', history: [], totals: { by_subagent: {}, by_model: {}, measured: ZERO_MEASURED },
  });
  assert.deepEqual(leftoverTempFiles(dir), []);
});
