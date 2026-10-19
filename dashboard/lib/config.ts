// Dashboard runtime config. Values default if the env var is unset or invalid.
// Number(undefined) is NaN, and NaN || fallback === fallback, so the short-circuit
// pattern below is safe for the realistic inputs (positive numbers).

export const DASHBOARD_BUDGET_DOLLARS = Number(process.env.DASHBOARD_BUDGET_DOLLARS) || 78;
export const DASHBOARD_COST_PER_KTOK = Number(process.env.DASHBOARD_COST_PER_KTOK) || 0.02;
