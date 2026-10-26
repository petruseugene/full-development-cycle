import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from '../plugin/scripts/lib/report-timeline.mjs';

const T = (m) => new Date(Date.UTC(2026, 9, 19, 1, m, 0)).toISOString();

test('timing: transcript, self-reported, point', () => {
  const r = buildTimeline([
    { ts: T(10), phase: 'spec', subagent: 's', status: 'DONE', started_at: T(1), ended_at: T(2) },
    { ts: T(10), phase: 'plan', subagent: 'p', status: 'DONE', duration_s: 120 },
    { ts: T(10), phase: 'git', subagent: 'g', status: 'DONE' },
  ]);
  const by = Object.fromEntries(r.timeline.map((x) => [x.phase, x]));
  assert.equal(by.spec.timing, 'transcript');
  assert.equal(by.spec.start, T(1));
  assert.equal(by.plan.timing, 'self-reported');
  assert.equal(by.plan.start, T(8));
  assert.equal(by.plan.end, T(10));
  assert.equal(by.git.timing, 'point');
  assert.equal(by.git.start, by.git.end);
});

test('overlapping intervals get different lanes; sequential reuse a lane', () => {
  const r = buildTimeline([
    { ts: T(10), phase: 'implement.task=1', subagent: 'b', status: 'DONE', duration_s: 300 },
    { ts: T(11), phase: 'implement.task=2', subagent: 'b', status: 'DONE', duration_s: 300 },
    { ts: T(20), phase: 'review', subagent: 'r', status: 'DONE', duration_s: 60 },
  ]);
  const lane = Object.fromEntries(r.timeline.map((x) => [x.phase, x.lane]));
  assert.notEqual(lane['implement.task=1'], lane['implement.task=2']);
  assert.equal(lane.review, 0);
  assert.equal(r.lanes, 2);
});

test('fix cycles: three implement.task=2 entries give cycles 1 and 2 with own cost', () => {
  const r = buildTimeline([
    { ts: T(1), phase: 'implement.task=2', subagent: 'b', status: 'DONE', usd_est: 1 },
    { ts: T(2), phase: 'implement.task=2', subagent: 'b', status: 'DONE', usd_est: 0.5 },
    { ts: T(3), phase: 'implement.task=2', subagent: 'b', status: 'DONE', tokens_k: 4 },
    { ts: T(4), phase: 'implement.area=ui', subagent: 'f', status: 'DONE' },
    { ts: T(5), phase: 'implement', subagent: 'f', status: 'DONE' },
  ]);
  assert.deepEqual(r.fix_cycles.map((c) => [c.task, c.cycle, c.usd_est, c.tokens_k]),
    [[2, 1, 0.5, undefined], [2, 2, undefined, 4]]);
});

test('fix cycles counted per key', () => {
  const r = buildTimeline([
    { ts: T(1), phase: 'implement.area=a', subagent: 'f', status: 'DONE' },
    { ts: T(2), phase: 'implement.area=b', subagent: 'f', status: 'DONE' },
    { ts: T(3), phase: 'implement.area=a', subagent: 'f', status: 'DONE' },
  ]);
  assert.equal(r.fix_cycles.length, 1);
  assert.equal(r.fix_cycles[0].task, 'implement.area=a');
});

test('20-minute gap yields one idle wait; 5-minute gap does not', () => {
  const r = buildTimeline([
    { ts: T(1), phase: 'spec', subagent: 's', status: 'DONE' },
    { ts: T(6), phase: 'plan', subagent: 'p', status: 'DONE' },
    { ts: T(26), phase: 'review', subagent: 'r', status: 'DONE' },
  ]);
  const idle = r.waits.filter((w) => w.kind === 'idle');
  assert.equal(idle.length, 1);
  assert.equal(idle[0].duration_s, 1200);
});

test('owner wait runs from latest plan DONE to owner ts', () => {
  const r = buildTimeline([
    { ts: T(1), phase: 'plan', subagent: 'p', status: 'DONE' },
    { ts: T(3), phase: 'plan', subagent: 'p', status: 'DONE' },
    { ts: T(5), phase: 'owner.task=4', subagent: 'owner', status: 'DONE' },
  ]);
  assert.deepEqual(r.waits, [{ kind: 'owner', task: 4, start: T(3), end: T(5), duration_s: 120 }]);
});

test('plan_groups from computeGroups; absent without tasks; empty history ok', () => {
  const tasks = [
    { n: 1, tag: 'backend', status: 'TODO', touches: ['a/**'], dependsOn: [] },
    { n: 2, tag: 'backend', status: 'TODO', touches: ['b/**'], dependsOn: [] },
    { n: 3, tag: 'backend', status: 'TODO', touches: ['c/**'], dependsOn: [1] },
  ];
  assert.deepEqual(buildTimeline([], { tasks }).plan_groups, [[1, 2], [3]]);
  const r = buildTimeline(undefined);
  assert.equal(r.plan_groups, undefined);
  assert.deepEqual(r.timeline, []);
});
