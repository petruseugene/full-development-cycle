/**
 * Client-only persistence for the Sidebar pinned-features rail.
 *
 * Storage shape: a JSON array of feature slugs (strings), ordered
 * most-recently-pinned first, written to `localStorage` under
 * `dashboard:pinned-features:v1`.
 *
 * All exports are SSR-safe: when `window` is undefined the read/write
 * helpers degrade to `[]` / no-op rather than throwing.
 */

const KEY = 'dashboard:pinned-features:v1';

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return false;
  }
  return true;
}

export function readPins(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isStringArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function writePins(slugs: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(slugs));
  } catch {
    // Quota or access errors — swallow; the in-memory list remains source of
    // truth until the next reload.
  }
}

export function pinFeature(slug: string): string[] {
  const current = readPins();
  if (current.includes(slug)) {
    return current;
  }
  const next = [slug, ...current];
  writePins(next);
  return next;
}

export function unpinFeature(slug: string): string[] {
  const current = readPins();
  if (!current.includes(slug)) {
    return current;
  }
  const next = current.filter((s) => s !== slug);
  writePins(next);
  return next;
}

export function subscribePins(cb: (slugs: string[]) => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const handler = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cb(readPins());
  };
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener('storage', handler);
  };
}
