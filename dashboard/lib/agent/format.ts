/**
 * Numeric / time formatting helpers shared by the Stats tab (Task 15) and the
 * Files tab (Task 16). Pure functions — no React, no DOM access — so they
 * unit-test in isolation and tree-shake into any client component.
 *
 * Spec refs:
 *   - R34 Conversation tile: `Wall-clock` reuses the elapsed format from the
 *     TopBar pill (`12m 03s` / `1h 23m 45s`).
 *   - R34 Tool-calls table:  `Total dur.` column rendered as `1.2s`, `350ms`,
 *     etc.
 *   - R36 Files tab: `last touched 12s ago` relative-time stamps.
 */

/**
 * Format a wall-clock duration in milliseconds as a hand-written-feeling
 * elapsed string.
 *
 *   - `< 1m`     → `Ss` (e.g. `42s`)
 *   - `< 1h`     → `Mm SSs` (zero-padded seconds, e.g. `12m 03s`)
 *   - `>= 1h`    → `Hh Mm SSs` (e.g. `1h 23m 45s`)
 *
 * Negative or non-finite inputs fall back to `0s` so a clock-drift event
 * never renders a `-3s` value in the UI.
 */
export function formatWallClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${m}m ${String(s).padStart(2, '0')}s`;
  }
  if (m > 0) {
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  return `${s}s`;
}

/**
 * Format a per-tool duration in milliseconds for the Tool-calls table.
 *
 *   - `< 1000ms`            → `Xms`           (e.g. `350ms`)
 *   - `< 60_000ms`          → `X.Ys`          (e.g. `1.2s`, `14.7s`)
 *   - `>= 60_000ms`         → wall-clock      (e.g. `2m 31s`)
 *
 * The `< 1s` branch deliberately uses integer ms (not `0.350s`) because the
 * wireframe shows `1.2s` / `0.8s` / `14.7s` only at the second scale. Below
 * one second the resolution is in milliseconds.
 */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    // One decimal place for the second-scale band. Use `toFixed(1)` so
    // `1000ms` → `1.0s` (consistent with the wireframe's `1.2s`).
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return formatWallClock(ms);
}

/**
 * Format an absolute timestamp as a relative-to-now string suitable for
 * "last touched" labels.
 *
 *   - `< 60s`               → `Ns ago`            (e.g. `12s ago`)
 *   - `< 60m`               → `Nm ago`            (e.g. `3m ago`)
 *   - `< 24h`               → `Nh ago`            (e.g. `1h ago`)
 *   - otherwise             → `Nd ago`            (e.g. `4d ago`)
 *
 * Future-dated inputs (clock skew between client + server) render `just now`
 * rather than a negative duration so the UI never confuses the user.
 */
export function formatRelativeTime(d: Date | string | number): string {
  const ts =
    d instanceof Date
      ? d.getTime()
      : typeof d === 'number'
        ? d
        : Date.parse(d);
  if (!Number.isFinite(ts)) return '—';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
