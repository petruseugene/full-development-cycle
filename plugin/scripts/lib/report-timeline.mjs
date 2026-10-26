// Report timeline model: bars, lanes, fix cycles, waits. Pure; no I/O.
// Input is a feature.json `history` array (+ optional plan tasks).

import { computeGroups } from './groups.mjs';

export const IDLE_WAIT_MS = 5 * 60 * 1000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const parseMs = (v) => {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
};
const iso = (ms) => new Date(ms).toISOString();

/** One entry → {startMs, endMs, timing}; null when it has no usable `ts`/interval. */
function timingOf(e) {
  const s = parseMs(e.started_at);
  const f = parseMs(e.ended_at);
  if (s !== undefined && f !== undefined && f >= s) return { startMs: s, endMs: f, timing: 'transcript' };
  const ts = parseMs(e.ts);
  if (ts === undefined) return null;
  const d = num(e.duration_s);
  if (d !== undefined && d > 0) return { startMs: ts - d * 1000, endMs: ts, timing: 'self-reported' };
  return { startMs: ts, endMs: ts, timing: 'point' };
}

const OWNER_RE = /^owner\.task=(\d+)$/;
const TASK_RE = /^[a-z-]+\.task=(\d+)$/;

/**
 * @param {Array<object>} history feature.json history entries
 * @param {{tasks?: Array<object>}} [opts] plan tasks → `plan_groups`
 * @returns {{timeline: object[], lanes: number, fix_cycles: object[], waits: object[], plan_groups?: number[][]}}
 */
export function buildTimeline(history, { tasks } = {}) {
  const entries = [];
  (Array.isArray(history) ? history : []).forEach((e, index) => {
    if (!e || typeof e !== 'object') return;
    if (e.status === 'RESOLVED') return; // concern resolution marker, not a run
    if (e.phase === 'worktree') return; // bookkeeping; shown as worktree rows, not bars
    const t = timingOf(e);
    if (!t) return;
    entries.push({ e, index, ...t });
  });

  // Lanes: greedy interval colouring, deterministic order (start, then phase, then history index).
  const sorted = [...entries].sort((a, b) =>
    a.startMs - b.startMs
    || String(a.e.phase ?? '').localeCompare(String(b.e.phase ?? ''))
    || a.index - b.index);
  const laneEnds = [];
  for (const it of sorted) {
    let lane = laneEnds.findIndex((end) => end <= it.startMs);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.endMs); } else laneEnds[lane] = it.endMs;
    it.lane = lane;
  }

  const timeline = sorted.map((it) => {
    const row = {
      index: it.index,
      phase: it.e.phase,
      subagent: it.e.subagent,
      status: it.e.status,
      start: iso(it.startMs),
      end: iso(it.endMs),
      timing: it.timing,
      lane: it.lane,
    };
    if (num(it.e.duration_s) !== undefined) row.duration_s = it.e.duration_s;
    if (num(it.e.usd_est) !== undefined) row.usd_est = it.e.usd_est;
    if (num(it.e.tokens_k) !== undefined) row.tokens_k = it.e.tokens_k;
    return row;
  });

  // Fix cycles: k-th (k>=2) entry per phase key is fix cycle k-1 (history order).
  const seen = new Map();
  const fix_cycles = [];
  for (const e of Array.isArray(history) ? history : []) {
    if (!e || e.status === 'RESOLVED' || typeof e.phase !== 'string' || !/^implement(\.|$)/.test(e.phase)) continue;
    const k = (seen.get(e.phase) ?? 0) + 1;
    seen.set(e.phase, k);
    if (k < 2) continue;
    const m = TASK_RE.exec(e.phase);
    const c = { task: m ? Number(m[1]) : e.phase, phase: e.phase, cycle: k - 1 };
    if (num(e.usd_est) !== undefined) c.usd_est = e.usd_est;
    if (num(e.tokens_k) !== undefined) c.tokens_k = e.tokens_k;
    fix_cycles.push(c);
  }

  // Waits: idle gaps (> 5 min) between running max end and next start; owner waits from latest plan DONE.
  const waits = [];
  let maxEnd;
  for (const it of sorted) {
    if (OWNER_RE.test(it.e.phase ?? '')) continue;
    if (maxEnd !== undefined && it.startMs - maxEnd > IDLE_WAIT_MS) {
      waits.push({ kind: 'idle', start: iso(maxEnd), end: iso(it.startMs), duration_s: Math.round((it.startMs - maxEnd) / 1000) });
    }
    maxEnd = maxEnd === undefined ? it.endMs : Math.max(maxEnd, it.endMs);
  }
  let planMs;
  for (const it of entries) {
    if (it.e.phase === 'plan' && String(it.e.status ?? '').startsWith('DONE')) planMs = planMs === undefined ? it.endMs : Math.max(planMs, it.endMs);
  }
  if (planMs !== undefined) {
    for (const it of sorted) {
      const m = OWNER_RE.exec(it.e.phase ?? '');
      const ts = parseMs(it.e.ts);
      if (!m || ts === undefined || ts < planMs) continue;
      waits.push({ kind: 'owner', task: Number(m[1]), start: iso(planMs), end: iso(ts), duration_s: Math.round((ts - planMs) / 1000) });
    }
  }

  const out = { timeline, lanes: laneEnds.length, fix_cycles, waits };
  if (Array.isArray(tasks)) out.plan_groups = computeGroups(tasks, { all: true }).groups;
  return out;
}
