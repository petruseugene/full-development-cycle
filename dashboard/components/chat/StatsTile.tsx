/**
 * StatsTile — small numeric tile primitive used by the Stats tab's
 * Cost & tokens and Conversation sections.
 *
 * Visual contract (spec §6.9, chat-redesign Task 8):
 *
 *   ┌────────────────────────┐
 *   │  COST (USD)            │  <- label: 11px uppercase ink-500 semibold
 *   │  $0.0042               │  <- value: mono 20px ink-900 semibold
 *   │  cache hit 47%         │  <- optional sub-label: 11px ink-500
 *   └────────────────────────┘
 *
 * Tile root reuses the dashboard's white-card primitive
 * (`bg-white border border-line rounded-lg p-3 shadow-sm`) so the chat
 * drawer matches `TaskCard` / `KPIStrip`. All inline styles and the
 * previous handwritten-display numeral are removed.
 */

import type { ReactNode } from 'react';

export interface StatsTileProps {
  /** Headline numeric value rendered in mono 20px. */
  value: ReactNode;
  /** Uppercase 11px label rendered above the value. */
  label: string;
  /** Optional small sub-label rendered beneath the value (e.g. "cache hit 47%"). */
  subLabel?: ReactNode;
}

export function StatsTile({
  value,
  label,
  subLabel,
}: StatsTileProps): JSX.Element {
  return (
    <div className="tile bg-white border border-line rounded-lg p-3 shadow-sm">
      <div className="lbl text-[11px] uppercase tracking-wide text-ink-500 font-semibold">
        {label}
      </div>
      <div className="num mono text-[20px] font-semibold text-ink-900 leading-tight tracking-tight">
        {value}
      </div>
      {subLabel ? (
        <div className="sub text-[11px] text-ink-500">{subLabel}</div>
      ) : null}
    </div>
  );
}

export default StatsTile;
