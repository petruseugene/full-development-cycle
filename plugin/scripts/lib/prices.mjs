// Price table ($ per MTok). Keyed by model-id prefix; longest prefix wins.
export const PRICES_AS_OF = '2026-10-06';

// cache_read defaults to 0.1x input when omitted.
export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function priceFor(model) {
  let best = null;
  for (const k of Object.keys(PRICES)) {
    if (String(model).startsWith(k) && (best === null || k.length > best.length)) best = k;
  }
  return best ? PRICES[best] : null;
}

/** by_model: { [model]: {input, output, cache_read, cache_write, cache_write_1h} } → {usd_est, usd_unpriced[]} */
export function estimateUsd(byModel) {
  let usd = 0;
  const unpriced = [];
  for (const [model, u] of Object.entries(byModel || {})) {
    const p = priceFor(model);
    if (!p) { unpriced.push(model); continue; }
    const w1h = Math.min(u.cache_write_1h || 0, u.cache_write || 0);
    const w5m = (u.cache_write || 0) - w1h;
    const cr = p.cache_read ?? p.input * 0.1;
    usd += ((u.input || 0) * p.input + (u.output || 0) * p.output + (u.cache_read || 0) * cr
      + w5m * p.input * 1.25 + w1h * p.input * 2) / 1e6;
  }
  return { usd_est: Math.round(usd * 1e4) / 1e4, usd_unpriced: unpriced };
}

export function formatUsd(x) {
  return `~$${x} (estimate, prices as of ${PRICES_AS_OF})`;
}
