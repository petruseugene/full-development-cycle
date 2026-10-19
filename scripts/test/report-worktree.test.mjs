import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFeature, buildWorktreeRows } from '../lib/report-model.mjs';
import { renderFeature } from '../lib/report-html.mjs';

const BASE = [
  { ts: '2026-01-01T10:00:00.000Z', phase: 'implement.task=1', subagent: 'backend-dev', status: 'DONE', model: 'sonnet', duration_s: 60, tokens_k: 3 },
  { ts: '2026-01-01T10:02:00.000Z', phase: 'implement.task=2', subagent: 'backend-dev', status: 'DONE', model: 'sonnet', duration_s: 60, tokens_k: 4 },
];
const WT = [
  { ts: '2026-01-01T10:03:00.000Z', phase: 'worktree', subagent: 'cli', status: 'COLLECTED', model: 'inherit', task: 1, touches_expanded: ['a.js', 'b.js'], conflicts: [] },
  { ts: '2026-01-01T10:03:01.000Z', phase: 'worktree', subagent: 'cli', status: 'CONFLICT', model: 'inherit', task: 2, touches_expanded: ['b.js', 'c.js'], conflicts: [{ path: 'x', reason: 'symlink' }] },
  { ts: '2026-01-01T10:03:02.000Z', phase: 'worktree', subagent: 'cli', status: 'ISOLATED', model: 'inherit', tasks: [1, 2], stray: ['s1', 's2', 's3'] },
];

function mk(history) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rwt-')), 'feat');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'feature.json'), JSON.stringify({ feature_slug: 'x', history }));
  return dir;
}

test('AC22: group entry yields a row with mode and counts', () => {
  const dir = mk([...BASE, ...WT]);
  try {
    const f = loadFeature(dir);
    assert.equal(f.worktrees.length, 1);
    const r = f.worktrees[0];
    assert.equal(r.mode, 'isolated');
    assert.equal(r.touches_expanded, 3);
    assert.equal(r.stray, 3);
    assert.equal(r.conflicts, 1);
    const html = renderFeature(f);
    assert.match(html, /id="worktrees"/);
    assert.match(html, /Worktrees/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit group entry reports mode audit', () => {
  const rows = buildWorktreeRows([{ phase: 'worktree', status: 'AUDIT', tasks: [1], stray: [] }]);
  assert.deepEqual(rows.map((r) => [r.mode, r.stray, r.touches_expanded, r.conflicts]), [['audit', 0, 0, 0]]);
});

test('AC22: no worktree entry leaves model and HTML unchanged; entries do not alter other fields', () => {
  const dirA = mk(BASE);
  const dirB = mk([...BASE, ...WT]);
  try {
    const a = loadFeature(dirA);
    assert.equal('worktrees' in a, false);
    assert.equal(renderFeature(a).includes('id="worktrees"'), false);
    const b = loadFeature(dirB);
    const { worktrees, history, gallery: gB, ...restB } = b;
    const { history: _h, gallery: gA, ...restA } = a;
    assert.equal(gB.exists, gA.exists);
    assert.ok(worktrees);
    assert.deepEqual(restB, restA); // timeline, waits, cost unaffected
    assert.equal(history.length, BASE.length + WT.length);
  } finally { fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true }); }
});
