// Budget check for a feature (skills/orchestrator/references/dashboard-format.md,
// "Budget warning line"). Pure: reads feature.json only.

import { countsTowardsTotals, computeTotals } from './totals.mjs';

const DEFAULTS = Object.freeze({ usd: 50, time_s: 7200 });
// budget key -> label shown for the current value.
const ORDER = [['usd', 'usd_est'], ['tokens_k', 'tokens_k'], ['time_s', 'time_s']];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : 0);
const round = (v) => Math.round(v * 1000) / 1000;

/**
 * @param {Record<string, any>} fj feature.json
 * @returns {{items: {key: string, label: string, value: number|null, limit: number, tripped: boolean}[],
 *   warning: string|null}}
 */
export function budgetCheck(fj) {
  const history = Array.isArray(fj?.history) ? fj.history : [];
  const given = fj?.budget && typeof fj.budget === 'object' && !Array.isArray(fj.budget) ? fj.budget : null;
  let limits = given ? Object.fromEntries(ORDER.filter(([k]) => isNum(given[k])).map(([k]) => [k, given[k]])) : {};
  if (Object.keys(limits).length === 0) limits = { ...DEFAULTS };

  const measured = computeTotals(history).measured;
  let tokensK = 0;
  let timeS = 0;
  for (const e of history) {
    if (!e || typeof e !== 'object') continue;
    const counted = countsTowardsTotals(e);
    if (counted || e.phase === 'orchestrator') tokensK += num(e.tokens_k);
    if (counted) timeS += num(e.duration_s);
  }
  const current = {
    usd: measured.measured_entries > 0 ? measured.usd_est : null,
    tokens_k: round(tokensK),
    time_s: round(timeS),
  };

  const items = [];
  for (const [key, label] of ORDER) {
    if (!Object.hasOwn(limits, key)) continue;
    const value = current[key];
    items.push({ key, label, value, limit: limits[key], tripped: value !== null && value > limits[key] });
  }
  const tripped = items.filter((i) => i.tripped);
  const warning = tripped.length
    ? `! BUDGET: ${tripped.map((i) => `${i.label}=${i.value} exceeds ${i.limit}`).join(', ')}; budget ${items.map((i) => `${i.key}=${i.limit}`).join(', ')}`
    : null;
  return { items, warning };
}

/** `budget: usd_est=60 of 50, time_s=0 of 7200` */
export function budgetLine(items) {
  return `budget: ${items.map((i) => `${i.label}=${i.value === null ? 'n/a' : i.value} of ${i.limit}`).join(', ')}`;
}
