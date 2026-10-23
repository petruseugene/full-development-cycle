// Pure KPI aggregation. No node imports so the board page can recompute the
// strip on the client for whatever feature set the filters leave visible.
import type { Feature, HistoryEvent, KPIs, Task } from './types';
import { DASHBOARD_BUDGET_DOLLARS, DASHBOARD_COST_PER_KTOK } from './config';

export interface KpiOptions {
  /** Per-feature budget in USD (DASHBOARD_BUDGET_DOLLARS). */
  budget?: number;
  /** Flat $/ktok rate, used only for legacy features without measured spend. */
  costPerKtok?: number;
}

/** A feature is closed when its feature.json says `current_phase == "done"`. */
export function isClosedFeature(f: Pick<Feature, 'meta'>): boolean {
  return f.meta?.current_phase === 'done';
}

/**
 * Tasks of a closed feature are merged by definition; their plan.md statuses
 * (IMPL-DONE / IN REVIEW ...) are stale leftovers. Normalising them to DONE
 * keeps the board's "Merged" column and the KPIs in agreement.
 */
export function closeTasksOfClosedFeature(tasks: Task[], meta: Feature['meta']): Task[] {
  if (meta?.current_phase !== 'done') return tasks;
  return tasks.map((t) => (t.status === 'DONE' ? t : { ...t, status: 'DONE' as const }));
}

/**
 * Tokens for one feature, same source as the "Spend by model" panel: the sum of
 * feature.json history `tokens_k` (every dispatch, incl. cli/orchestrator
 * entries). `totals.by_subagent` omits some of those entries, so it is only a
 * fallback for legacy features whose history carries no token figures.
 */
export function featureTokensK(f: Feature): number {
  const history = f.meta?.history;
  if (Array.isArray(history)) {
    let sum = 0;
    let any = false;
    for (const h of history) {
      const v = Number(h?.tokens_k);
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        any = true;
      }
    }
    if (any) return sum;
  }
  const by = f.meta?.totals?.by_subagent ?? {};
  return Object.values(by).reduce((s, x) => s + (Number(x?.tokens_k) || 0), 0);
}

export function buildKPIs(features: Feature[], opts: KpiOptions = {}): KPIs {
  const budget = opts.budget || DASHBOARD_BUDGET_DOLLARS;
  const costPerKtok = opts.costPerKtok || DASHBOARD_COST_PER_KTOK;

  // In-flight / blocked only look at open features: closed ones are finished
  // regardless of what their task lines still say.
  const openTasks = features.filter((f) => !isClosedFeature(f)).flatMap((f) => f.tasks);
  const tasksInFlight = openTasks.filter(
    (t) => t.status === 'IN_PROGRESS' || t.status === 'IN_TESTING',
  ).length;
  const blocked = openTasks.filter((t) => t.status === 'BLOCKED').length;

  const cycles = features
    .filter((f) => f.derived.overallStatus === 'DONE' && f.meta?.history?.length)
    .map((f) => totalDurationHours(f.meta!.history))
    .filter((h): h is number => h != null && h > 0);
  const avgCycleHours = cycles.length
    ? cycles.reduce((a, b) => a + b, 0) / cycles.length
    : null;

  const tokens_k = features.reduce((sum, f) => sum + featureTokensK(f), 0);
  const dollars = +features
    .reduce((sum, f) => {
      const m = f.meta?.totals?.measured;
      if (m && Number(m.measured_entries) > 0) return sum + (Number(m.usd_est) || 0);
      return sum + featureTokensK(f) * costPerKtok;
    }, 0)
    .toFixed(2);

  return {
    activeFeatures: features.filter((f) => f.derived.overallStatus !== 'DONE').length,
    tasksInFlight,
    blocked,
    avgCycleHours,
    // `budget` is a PER-FEATURE allowance, so UI compares it to spend only when
    // exactly one feature is in scope (featureCount === 1); see KPIStrip.
    agentSpend: {
      dollars,
      tokens: Math.round(tokens_k * 1000),
      budget,
      featureCount: features.length,
      costPerKtok,
    },
    trends: buildTrends(features),
  };
}

function totalDurationHours(history: HistoryEvent[]): number | null {
  const secs = history.reduce((s, h) => s + (h.duration_s || 0), 0);
  return secs > 0 ? +(secs / 3600).toFixed(2) : null;
}

/**
 * Returns an array of `daysBack` UTC YYYY-MM-DD date strings, oldest -> newest,
 * with the last entry being today (UTC). Used for per-day trend bucketing.
 */
function bucketByDay(daysBack = 9): string[] {
  const out: string[] = [];
  const today = new Date();
  // Anchor at UTC midnight for the current day.
  const anchor = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = daysBack - 1; i >= 0; i--) {
    out.push(new Date(anchor - i * dayMs).toISOString().slice(0, 10));
  }
  return out;
}

function dayKey(ts: string | undefined | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildTrends(features: Feature[]): KPIs['trends'] {
  const days = bucketByDay(9);

  // activeFeatures: per day, count features created on or before that day
  // whose overall status (as-of-today) is not DONE. This is the documented
  // R6 approximation since we lack per-day phase snapshots.
  const activeFeatures = days.map((day) =>
    features.filter((f) => {
      const created = dayKey(f.meta?.created);
      if (!created) return false;
      if (created > day) return false;
      return f.derived.overallStatus !== 'DONE';
    }).length,
  );

  // blocked: per day, count of BLOCKED history events whose ts falls on that day.
  const blockedByDay = new Map<string, number>();
  for (const f of features) {
    for (const ev of f.meta?.history ?? []) {
      if (ev.status !== 'BLOCKED') continue;
      const k = dayKey(ev.ts);
      if (!k) continue;
      blockedByDay.set(k, (blockedByDay.get(k) ?? 0) + 1);
    }
  }
  const blocked = days.map((day) => blockedByDay.get(day) ?? 0);

  // cycleHours: per day, mean cycle hours among DONE features whose latest
  // history entry falls on that day. Carry forward previous day's value when
  // empty so the sparkline has no visual gaps. Initial day defaults to 0.
  const cycleByDay = new Map<string, number[]>();
  for (const f of features) {
    if (f.derived.overallStatus !== 'DONE') continue;
    const history = f.meta?.history ?? [];
    if (!history.length) continue;
    const latest = history[history.length - 1];
    const k = dayKey(latest?.ts);
    if (!k) continue;
    const hours = totalDurationHours(history);
    if (hours == null) continue;
    const arr = cycleByDay.get(k) ?? [];
    arr.push(hours);
    cycleByDay.set(k, arr);
  }
  const cycleHours: number[] = [];
  let last = 0;
  for (const day of days) {
    const arr = cycleByDay.get(day);
    if (arr && arr.length) {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      last = +mean.toFixed(2);
    }
    cycleHours.push(last);
  }

  return { activeFeatures, blocked, cycleHours };
}

