import type { KPIs } from './types';

/**
 * Budget line for the Agent spend card.
 *
 * `budget` (DASHBOARD_BUDGET_DOLLARS, default $78) is a PER-FEATURE allowance,
 * not a project-wide one. Comparing the spend of many features to it is
 * meaningless (e.g. 446%), so the percentage is shown only when exactly one
 * feature is in scope. For any other scope we show the feature count and the
 * average spend per feature instead.
 */
export function spendBudgetLine(spend: KPIs['agentSpend']): { label: string; pct: number | null } {
  const n = spend.featureCount ?? 1;
  if (n === 1) {
    const pct = spend.budget > 0 ? Math.round((spend.dollars / spend.budget) * 100) : 0;
    return { label: `${pct}% of $${spend.budget} feature budget`, pct };
  }
  if (n === 0) return { label: 'no features in scope', pct: null };
  const avg = spend.dollars / n;
  return { label: `${n} features · avg $${avg.toFixed(2)} each`, pct: null };
}
