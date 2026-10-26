// Shared display formatters.

// Time formatter: "Xm YYs" (e.g. "14m 12s", "0m 00s").
export function formatTime(time_s: number): string {
  const s = Math.round(time_s);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Tokens formatter: one decimal "Nk" below 1000k (e.g. "28.4k", "0.0k"),
// "N.NM" from 1000k up (e.g. "24.2M").
export function formatTokens(tokens_k: number): string {
  if (Math.abs(tokens_k) >= 999.95) return `${(tokens_k / 1000).toFixed(1)}M`;
  return `${tokens_k.toFixed(1)}k`;
}
