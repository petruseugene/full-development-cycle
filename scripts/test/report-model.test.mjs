import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportModel, listFeatureFolders, loadFeature, prState, unconfirmedMerges, waitingOwner,
} from '../lib/report-model.mjs';
import { GitFailure } from '../lib/git-exec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'fixtures', 'report');
const NOW = '2026-02-01T00:00:00.000Z';
const OWNER = '2026-01-04-00h-00m-owner-merges';
const PROFILE = {
  post_merge: [
    { name: 'smoke', cmd: 'npm run smoke', confirm: true },
    { name: 'store', cmd: 'npm run store', confirm: true },
    { name: 'notify', cmd: 'npm run notify' },
  ],
};

/** gh stub recording calls; `reply(args)` returns a result or throws. */
function stubGh(reply) {
  const calls = [];
  const gh = async (args, opts) => { calls.push({ args, opts }); return reply(args, opts); };
  return { gh, calls };
}

const build = (over = {}) => buildReportModel({ featuresRoot: ROOT, now: NOW, profile: PROFILE, noNetwork: true, ...over });
const prRow = (model, folder = OWNER) => model.unconfirmed_merges.find((r) => r.folder === folder && r.kind === 'pr');

test('listFeatureFolders: sorted, only folders with feature.json', () => {
  const names = listFeatureFolders(ROOT);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('2025-06-01-legacy'));
  assert.ok(names.includes('2026-01-06-00h-00m-malformed'));
  assert.deepEqual(listFeatureFolders(path.join(ROOT, 'nope')), []);
});

test('AC21: field presence over the fixture root', async () => {
  const model = await build();
  const json = JSON.parse(JSON.stringify(model));
  for (const k of ['trend', 'tracks', 'waiting_owner', 'unconfirmed_merges', 'features']) assert.ok(Array.isArray(json[k]), k);
  assert.equal(json.generated_at, NOW);
  for (const p of json.trend) assert.equal(typeof p.measured, 'boolean');
  for (const t of json.tracks) {
    assert.equal(typeof t.n, 'number');
    assert.equal(typeof t.small_sample, 'boolean');
  }
  const readable = json.features.filter((f) => !f.unreadable);
  assert.ok(readable.length >= 6);
  for (const f of readable) {
    assert.ok(Array.isArray(f.timeline), f.folder);
    for (const t of f.timeline) {
      assert.ok(t.start && t.end);
      assert.ok(['transcript', 'self-reported', 'point'].includes(t.timing));
    }
    assert.equal(typeof f.lanes, 'number');
    assert.ok(Array.isArray(f.fix_cycles));
    assert.ok(Array.isArray(f.waits));
    assert.ok(f.cost.by_agent && f.cost.by_model);
    assert.ok(Array.isArray(f.ac_map));
    for (const k of ['path', 'exists', 'verdict', 'run_time_s', 'budget_s']) assert.ok(k in f.gallery, `${f.folder} gallery.${k}`);
  }
  const tl = readable.find((f) => f.folder === '2026-01-01-00h-00m-timeline');
  assert.deepEqual(new Set(tl.timeline.map((t) => t.timing)), new Set(['transcript', 'self-reported', 'point']));
  assert.ok(tl.lanes >= 2);
  assert.deepEqual(tl.fix_cycles.map((c) => [c.task, c.cycle, c.usd_est]), [[2, 1, 0.25], [2, 2, 0.75]]);
  assert.ok(tl.waits.some((w) => w.kind === 'idle'));
  assert.ok(Array.isArray(tl.plan_groups));
});

test('features sorted by folder; deterministic for a fixed now', async () => {
  const a = await build();
  const b = await build();
  assert.deepEqual(a.features.map((f) => f.folder), [...a.features.map((f) => f.folder)].sort());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('R20: malformed feature.json is listed as unreadable, not thrown', async () => {
  const model = await build();
  const bad = model.features.find((f) => f.folder === '2026-01-06-00h-00m-malformed');
  assert.match(bad.unreadable, /invalid JSON/);
  assert.ok(!model.trend.some((p) => p.folder === bad.folder));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-model-'));
  try {
    fs.mkdirSync(path.join(tmp, 'arr'));
    fs.writeFileSync(path.join(tmp, 'arr', 'feature.json'), '[1]');
    assert.equal(loadFeature(path.join(tmp, 'arr')).unreadable, 'feature.json is not an object');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Compatibility: legacy folder loads with estimated/self-reported/unknown labels', () => {
  const f = loadFeature(path.join(ROOT, '2025-06-01-legacy'));
  assert.equal(f.unreadable, undefined);
  assert.equal(f.track, null);
  assert.equal(f.started_at, null);
  assert.deepEqual(f.timeline.map((t) => t.timing), ['point', 'self-reported']);
  assert.deepEqual(f.cost.counts, { measured: 0, estimated: 2 });
  assert.ok(f.ac_map.every((r) => r.class === 'unknown'));
  assert.equal(f.gallery.exists, false);
  assert.equal(f.gallery.verdict, null);
  assert.deepEqual(f.tasks.map((t) => t.n), [1]); // tasks from spec.md `## Tasks`
});

test('R25: gallery from manifest, path relative to the project root', () => {
  const dir = path.join(ROOT, '2026-01-05-00h-00m-xss');
  const g = loadFeature(dir, { projectRoot: path.dirname(ROOT) }).gallery;
  assert.deepEqual(g, { path: 'report/2026-01-05-00h-00m-xss/verification/index.html', exists: true, verdict: 'PASSED', run_time_s: 42, budget_s: 360 });
});

test('XSS fixture: raw payloads are kept as data for the renderer to escape', () => {
  const f = loadFeature(path.join(ROOT, '2026-01-05-00h-00m-xss'));
  assert.equal(f.title, '<script>alert(1)</script>');
  assert.match(f.tasks[0].title, /javascript:alert/);
  assert.match(f.history[0].summary, /onerror=/);
});

test('AC26: open owner task waits since the latest plan DONE; completed wait has its duration', async () => {
  const model = await build();
  const rows = model.waiting_owner.filter((r) => r.folder === OWNER);
  const open = rows.find((r) => !r.completed);
  assert.equal(open.task, 2);
  assert.equal(open.status, 'TODO');
  assert.equal(open.since, '2026-01-04T01:00:00.000Z');
  assert.equal(open.since_source, 'plan');
  assert.equal(open.waiting_s, (Date.parse(NOW) - Date.parse(open.since)) / 1000);
  const done = rows.find((r) => r.completed);
  assert.equal(done.task, 3);
  assert.equal(done.duration_s, 7200);
  assert.ok(!rows.some((r) => r.task === 1));
});

test('waiting owner falls back to started_at without a plan DONE entry', () => {
  const rows = waitingOwner([{
    folder: 'f', started_at: '2026-01-01T00:00:00.000Z', history: [],
    tasks: [{ n: 4, title: 'sign', status: 'IN PROGRESS', owner: true }],
  }], { now: '2026-01-01T01:00:00.000Z' });
  assert.deepEqual(rows, [{
    folder: 'f', task: 4, title: 'sign', status: 'IN PROGRESS', completed: false,
    since: '2026-01-01T00:00:00.000Z', since_source: 'started_at', waiting_s: 3600,
  }]);
});

test('AC26: --no-network gives unknown and never calls gh', async () => {
  const { gh, calls } = stubGh(() => { throw new Error('must not be called'); });
  const model = await build({ gh, noNetwork: true });
  assert.equal(prRow(model).state, 'unknown');
  assert.equal(calls.length, 0);
});

test('AC26: OPEN gives open; MERGED is absent; gh argv and 10 s timeout', async () => {
  const open = stubGh(() => ({ code: 0, stdout: '{"state":"OPEN","mergedAt":null,"url":"https://github.com/o/r/pull/1"}', stderr: '' }));
  let model = await build({ gh: open.gh, noNetwork: false });
  assert.deepEqual(prRow(model), { folder: OWNER, kind: 'pr', branch: 'feat/owner-merges', state: 'open', url: 'https://github.com/o/r/pull/1' });
  assert.deepEqual(open.calls.map((c) => c.args), [['pr', 'view', 'feat/owner-merges', '--json', 'state,mergedAt,url']]);
  assert.equal(open.calls[0].opts.timeout_s, 10);

  const merged = stubGh(() => ({ code: 0, stdout: '{"state":"MERGED","mergedAt":"2026-01-05T00:00:00Z"}', stderr: '' }));
  model = await build({ gh: merged.gh, noNetwork: false });
  assert.equal(prRow(model), undefined);
});

test('AC26: CLOSED without mergedAt gives closed-unmerged', async () => {
  assert.deepEqual(await prState('b', { gh: async () => ({ code: 0, stdout: '{"state":"CLOSED","mergedAt":null}' }) }), { state: 'closed-unmerged' });
});

test('AC26: gh exit 1, timeout, hang and non-JSON all give unknown without throwing', async () => {
  const cases = [
    async () => ({ code: 1, stdout: '', stderr: 'no pull requests found' }),
    async () => { throw new GitFailure('timeout', 'gh pr did not finish within 10s'); },
    async () => ({ code: 0, stdout: 'not json', stderr: '' }),
    async () => ({ code: 0, stdout: '"OPEN"', stderr: '' }),
    async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); },
  ];
  for (const gh of cases) {
    const model = await build({ gh, noNetwork: false });
    assert.equal(prRow(model).state, 'unknown');
  }
  const hang = await prState('b', { gh: () => new Promise(() => {}), timeout_s: 0.01 });
  assert.deepEqual(hang, { state: 'unknown', reason: 'timeout' });
});

test('AC26 / L2: unsafe branch is never passed to gh', async () => {
  const { gh, calls } = stubGh(() => ({ code: 0, stdout: '{"state":"OPEN"}' }));
  const model = await build({ gh, noNetwork: false });
  assert.equal(prRow(model, '2026-01-08-00h-00m-bad-branch').state, 'unknown');
  assert.ok(calls.every((c) => c.args[2] === 'feat/owner-merges'));
  for (const b of ['x;rm -rf /', '--repo=evil/x', '-R', '$(touch X)', 'a b', '']) {
    const s = stubGh(() => ({ code: 0, stdout: '{"state":"OPEN"}' }));
    assert.equal((await prState(b, { gh: s.gh })).state, 'unknown', b);
    assert.equal(s.calls.length, 0, b);
  }
});

test('AC26: done feature lists confirm:true post-merge steps without a log', async () => {
  const model = await build();
  const steps = model.unconfirmed_merges.filter((r) => r.folder === OWNER && r.kind === 'post-merge').map((r) => r.step);
  assert.deepEqual(steps, ['store']); // smoke.log exists; notify has no confirm
});

test('post-merge steps only for merged or done features', async () => {
  const f = { folder: 'f', current_phase: 'review', branch: 'feat/f', history: [{ phase: 'git' }], post_merge_logs: [] };
  const open = await unconfirmedMerges([f], { profile: PROFILE, gh: async () => ({ code: 0, stdout: '{"state":"OPEN"}' }) });
  assert.deepEqual(open.map((r) => r.kind), ['pr']);
  const merged = await unconfirmedMerges([f], { profile: PROFILE, gh: async () => ({ code: 0, stdout: '{"state":"MERGED","mergedAt":"x"}' }) });
  assert.deepEqual(merged.map((r) => r.step), ['smoke', 'store']);
  const noGit = await unconfirmedMerges([{ ...f, history: [] }], { profile: {}, gh: async () => { throw new Error('no'); } });
  assert.deepEqual(noGit, []);
});
