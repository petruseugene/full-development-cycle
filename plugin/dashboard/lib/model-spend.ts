export interface ModelSpendRow {
  model: string;
  calls: number;
  tokens_k: number;
  time_s: number;
}

const ORDER = ['opus', 'sonnet', 'haiku', 'inherit'];

function rank(model: string): number {
  if (model === 'unknown') return ORDER.length + 1;
  const i = ORDER.indexOf(model);
  return i === -1 ? ORDER.length : i;
}

/**
 * Aggregate feature.json history per model. Tolerates legacy history (no
 * `model` -> `unknown`), extra keys and odd statuses. Pure, O(n).
 */
export function aggregateByModel(history: unknown): ModelSpendRow[] {
  if (!Array.isArray(history)) return [];
  const buckets = new Map<string, ModelSpendRow>();
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const m = typeof e.model === 'string' ? e.model.trim().toLowerCase() : '';
    const key = m || 'unknown';
    let row = buckets.get(key);
    if (!row) {
      row = { model: key, calls: 0, tokens_k: 0, time_s: 0 };
      buckets.set(key, row);
    }
    row.calls += 1;
    row.tokens_k += Number(e.tokens_k) || 0;
    row.time_s += Number(e.duration_s) || 0;
  }
  return Array.from(buckets.values()).sort((a, b) => {
    const ra = rank(a.model);
    const rb = rank(b.model);
    if (ra !== rb) return ra - rb;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
}
