// Shared display formatters.

// Time formatter: "Xm YYs" (e.g. "14m 12s", "0m 00s").
export function formatTime(time_s: number): string {
  const s = Math.round(time_s);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Tokens formatter: one decimal "Nk" (e.g. "28.4k", "0.0k").
export function formatTokens(tokens_k: number): string {
  return `${tokens_k.toFixed(1)}k`;
}
