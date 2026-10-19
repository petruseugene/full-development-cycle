// Pure totals computation for feature.json (spec R10).
//
// `totals` is never edited incrementally: every CLI write to feature.json
// replaces it with computeTotals(history). Running it twice on the same
// history yields deep-equal output.

/** Phases that are not subagent calls and are excluded from totals. */
const EXCLUDED_PHASES = new Set(['interview', 'conflict']);

/** Statuses counted as `approved`. */
export const APPROVED_STATUSES = new Set(['APPROVED', 'PASSED']);

/** Statuses counted as `retried`. */
export const RETRIED_STATUSES = new Set(['CHANGES_REQUIRED', 'FAILED', 'NEEDS_CONTEXT']);

/**
 * True when a history entry counts towards totals. Entries in phase
 * `interview`, `conflict` or `gate.*` are orchestrator/CLI bookkeeping, not
 * subagent dispatches, so they are excluded entirely (calls, time and tokens).
 * @param {object} entry
 */
export function countsTowardsTotals(entry) {
  const phase = typeof entry?.phase === 'string' ? entry.phase : '';
  if (EXCLUDED_PHASES.has(phase)) return false;
  if (phase.startsWith('gate.')) return false;
  if (phase === 'orchestrator') return false;
  if (entry?.executor === 'cli') return false;
  return true;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Round to 3 decimals so float sums (0.1 + 0.2) stay readable and stable. */
function round(v) {
  return Math.round(v * 1000) / 1000;
}

function isMeasured(entry) {
  return entry.tokens !== null && typeof entry.tokens === 'object' && !Array.isArray(entry.tokens);
}

function billableK(input, output, cacheWrite) {
  return Math.round(((input + output + cacheWrite) / 1000) * 10) / 10;
}

function keyOf(v) {
  return typeof v === 'string' && v !== '' ? v : 'unknown';
}

/**
 * Compute `totals` from `history`.
 *
 * - by_subagent[s] = { calls, approved, retried, time_s, tokens_k }
 * - by_model[m]    = { calls, time_s, tokens_k }  (m = entry.model or "unknown")
 *
 * Keys appear in first-seen history order. Non-array input is treated as [].
 * @param {Array<object>} history
 * @returns {{by_subagent: Record<string, object>, by_model: Record<string, object>, measured: object, orchestrator?: object}}
 */
export function computeTotals(history) {
  // Maps: subagent/model keys come from feature.json, so `__proto__` must stay data.
  const bySubagent = new Map();
  const byModel = new Map();
  const measured = {
    input: 0, output: 0, cache_read: 0, cache_write: 0,
    billable_k: 0, usd_est: 0, measured_entries: 0, estimated_entries: 0,
  };
  let orch = null;
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry || typeof entry !== 'object') continue;
    const isM = isMeasured(entry);
    // Fallback entries (`history add --agent-id` without a transcript) carry
    // `tokens_k` + `estimated: true` and no `tokens` object — count them all.
    if (entry.estimated === true) measured.estimated_entries += 1;
    if (isM) {
      const t = entry.tokens;
      measured.input += num(t.input);
      measured.output += num(t.output);
      measured.cache_read += num(t.cache_read);
      measured.cache_write += num(t.cache_write);
      measured.usd_est = round(measured.usd_est + num(entry.usd_est));
      measured.measured_entries += 1;
      if (entry.phase === 'orchestrator') {
        orch ??= { input: 0, output: 0, cache_write: 0, usd_est: 0 };
        orch.input += num(t.input);
        orch.output += num(t.output);
        orch.cache_write += num(t.cache_write);
        orch.usd_est = round(orch.usd_est + num(entry.usd_est));
      }
    }
    if (!countsTowardsTotals(entry)) continue;
    const status = typeof entry.status === 'string' ? entry.status.toUpperCase() : '';
    const time = num(entry.duration_s);
    const tokens = num(entry.tokens_k);

    const sk = keyOf(entry.subagent);
    if (!bySubagent.has(sk)) bySubagent.set(sk, { calls: 0, approved: 0, retried: 0, time_s: 0, tokens_k: 0 });
    const s = bySubagent.get(sk);
    s.calls += 1;
    if (APPROVED_STATUSES.has(status)) s.approved += 1;
    if (RETRIED_STATUSES.has(status)) s.retried += 1;
    s.time_s = round(s.time_s + time);
    s.tokens_k = round(s.tokens_k + tokens);
    if (isM) s.usd_est = round((s.usd_est ?? 0) + num(entry.usd_est));

    const mk = keyOf(entry.model);
    if (!byModel.has(mk)) byModel.set(mk, { calls: 0, time_s: 0, tokens_k: 0 });
    const m = byModel.get(mk);
    m.calls += 1;
    m.time_s = round(m.time_s + time);
    m.tokens_k = round(m.tokens_k + tokens);
    if (isM) m.usd_est = round((m.usd_est ?? 0) + num(entry.usd_est));
  }
  measured.billable_k = billableK(measured.input, measured.output, measured.cache_write);
  const out = { by_subagent: Object.fromEntries(bySubagent), by_model: Object.fromEntries(byModel), measured };
  if (orch) {
    out.orchestrator = { billable_k: billableK(orch.input, orch.output, orch.cache_write), usd_est: orch.usd_est };
  }
  return out;
}
