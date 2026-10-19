// Pure cost, trend and track-comparison model for `dev-cycle report` (AC21, AC23, AC24).
// No I/O: callers pass parsed feature.json data.

import { countsTowardsTotals } from './totals.mjs';

const SMALL_SAMPLE_N = 3;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

function isMeasured(entry) {
  return entry?.tokens !== null && typeof entry?.tokens === 'object' && !Array.isArray(entry.tokens);
}

/** Strip the `dev-cycle:` plugin prefix so `dev-cycle:discovery` and `discovery` merge. */
export function normalizeAgent(name) {
  if (typeof name !== 'string' || name === '') return 'unknown';
  const n = name.startsWith('dev-cycle:') ? name.slice('dev-cycle:'.length) : name;
  return n === '' ? 'unknown' : n;
}

function key(v) {
  return typeof v === 'string' && v !== '' ? v : 'unknown';
}

function bump(map, k, entry) {
  if (!map.has(k)) map.set(k, { calls: 0, tokens_k: 0, usd_est: 0, measured: 0, estimated: 0 });
  const r = map.get(k);
  r.calls += 1;
  r.tokens_k = round(r.tokens_k + num(entry.tokens_k));
  if (isMeasured(entry)) {
    r.usd_est = round(r.usd_est + num(entry.usd_est));
    r.measured += 1;
  } else {
    r.estimated += 1;
  }
}

function toObject(map) {
  const out = {};
  for (const [k, v] of map) {
    out[k] = { calls: v.calls, tokens_k: v.tokens_k, measured: v.measured, estimated: v.estimated };
    // Measured USD and estimated tokens stay separate columns: usd only when measured data exists.
    if (v.measured > 0) out[k].usd_est = v.usd_est;
  }
  return out;
}

/**
 * Cost breakdown of one feature history. CLI/bookkeeping entries are excluded
 * (same rule as totals). Keys appear in first-seen order.
 * @returns {{by_agent: object, by_model: object, by_phase: object, counts: {measured: number, estimated: number}}}
 */
export function buildCost(history) {
  const byAgent = new Map();
  const byModel = new Map();
  const byPhase = new Map();
  const counts = { measured: 0, estimated: 0 };
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry || typeof entry !== 'object' || !countsTowardsTotals(entry)) continue;
    if (isMeasured(entry)) counts.measured += 1;
    else counts.estimated += 1;
    bump(byAgent, normalizeAgent(entry.subagent), entry);
    bump(byModel, key(entry.model), entry);
    const phase = key(entry.phase).replace(/\.task=.*$/, '');
    bump(byPhase, phase, entry);
  }
  return { by_agent: toObject(byAgent), by_model: toObject(byModel), by_phase: toObject(byPhase), counts };
}

function featureTotals(feature) {
  const history = (Array.isArray(feature?.history) ? feature.history : []).filter(
    (e) => e && typeof e === 'object' && countsTowardsTotals(e),
  );
  const measured = history.some(isMeasured);
  let usd = 0;
  let tokensK = 0;
  for (const e of history) {
    if (isMeasured(e)) usd += num(e.usd_est);
    tokensK += num(e.tokens_k);
  }
  return { measured, usd_est: round(usd), tokens_k: round(tokensK) };
}

/**
 * Cost trend across features, ordered by `created` (ties keep input order).
 * @returns {Array<{folder, created, measured: boolean, usd_est?: number, tokens_k?: number}>}
 */
export function buildTrend(features) {
  const list = (Array.isArray(features) ? features : []).filter((f) => f && typeof f === 'object');
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ca = String(a.f.created ?? '');
      const cb = String(b.f.created ?? '');
      return ca < cb ? -1 : ca > cb ? 1 : a.i - b.i;
    })
    .map(({ f }) => {
      const t = featureTotals(f);
      const point = { folder: f.folder, created: f.created ?? null, measured: t.measured };
      if (t.measured) point.usd_est = t.usd_est;
      point.tokens_k = t.tokens_k;
      return point;
    });
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

function wallSeconds(history) {
  const ts = (Array.isArray(history) ? history : [])
    .map((e) => Date.parse(e?.ts))
    .filter((t) => Number.isFinite(t));
  if (ts.length < 2) return null;
  return Math.round((Math.max(...ts) - Math.min(...ts)) / 1000);
}

/**
 * Compare flow/track groups. A feature-flow entry without `track` counts as
 * `full`; bugfix is its own group (track null unless stated).
 */
export function buildTracks(features) {
  const groups = new Map();
  for (const f of Array.isArray(features) ? features : []) {
    if (!f || typeof f !== 'object') continue;
    const flow = typeof f.flow === 'string' && f.flow !== '' ? f.flow : 'feature';
    let track = typeof f.track === 'string' && f.track !== '' ? f.track : null;
    if (flow === 'feature' && track === null) track = 'full';
    const gk = `${flow}\u0000${track ?? ''}`;
    if (!groups.has(gk)) groups.set(gk, { flow, track, items: [] });
    groups.get(gk).items.push(f);
  }
  return [...groups.values()].map(({ flow, track, items }) => {
    const totals = items.map(featureTotals);
    const usd = totals.filter((t) => t.measured).map((t) => t.usd_est);
    const walls = items.map((f) => wallSeconds(f.history)).filter((w) => w !== null);
    return {
      flow,
      track,
      n: items.length,
      small_sample: items.length < SMALL_SAMPLE_N,
      median_usd: median(usd),
      usd_n: usd.length,
      median_tokens_k: median(totals.map((t) => t.tokens_k)),
      median_wall_s: median(walls),
    };
  });
}
