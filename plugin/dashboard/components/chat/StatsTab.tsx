'use client';

/**
 * StatsTab — Stats panel for the chat drawer.
 *
 * Renders five sections (R34 / AC25–AC30 from the original chat-control-panel
 * feature, restyled by chat-redesign Task 8 per spec §6.9 / §6.10):
 *
 *   1. Cost & tokens   (4-tile grid)
 *   2. Conversation    (2-tile grid)
 *   3. Tools used      (chip row)
 *   4. Files touched   (mono row list)
 *   5. Subagents       (inline tile rows)
 *
 * Visual contract (chat-redesign §5, §6.9, §6.10):
 *   - Section shell: `bg-white border border-line rounded-lg p-3 shadow-sm`.
 *   - Section heading: `text-[12.5px] font-semibold text-ink-900`.
 *   - No handwritten-display fonts, no kraft paper, no asymmetric radii.
 *   - Tool chips reuse the dashboard chip palette table from spec §5:
 *       .chip.phase-implement (blue)  → read-family tools (Read / Glob / Edit / Write…)
 *       .chip.mixed           (purple) → Task / subagent dispatch
 *       .chip.infra           (amber)  → Grep / Bash / search
 *       .chip.st-done         (green)  → WebFetch / WebSearch
 *       .chip.st-none         (gray)   → fallback
 *
 * Polling contract (R33 / AC5) is unchanged from the original implementation:
 *   - Poll `GET /api/agent/[featureId]/stats` every 3 s while
 *     `document.visibilityState === 'visible'` AND `sessionStatus === 'running'`
 *     AND the component is mounted.
 *   - One-shot refresh on mount, `featureId` change, and `sessionStatus`
 *     change so the user always sees fresh numbers even when polling is paused.
 *
 * The endpoint returns either `{}` (no live session — empty-state for every
 * section) or a `SessionStats` snapshot per `dashboard/lib/agent/stats.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  FileTouchStat,
  SessionStats,
  SubagentStat,
  ToolCallStat,
} from '@/lib/agent/stats';
import {
  formatRelativeTime,
  formatToolDuration,
  formatWallClock,
} from '@/lib/agent/format';

import { StatsTile } from './StatsTile';

const POLL_INTERVAL_MS = 3000;
const EM_DASH = '—';

/** Session-status values that gate live polling (mirror ChatDrawer.tsx). */
type SessionStatus =
  | 'no_session'
  | 'running'
  | 'idle'
  | 'awaiting_approval'
  | 'errored';

export interface StatsTabProps {
  featureId: string;
  sessionStatus: SessionStatus;
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Fetch + polling                                                       */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Detect whether a fetched snapshot is the "no live session" empty body
 * (`{}`) the API returns when `sessionManager.get(featureId)` resolves to
 * nothing. We use the presence of `startedAt` as the sentinel because every
 * real `SessionStats` is created with a startedAt and the empty body has no
 * keys.
 */
function isEmptyStatsBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return true;
  return !('startedAt' in (body as Record<string, unknown>));
}

/** Type-guard masquerading as a coercion: trust the API shape but be defensive. */
function asSessionStats(body: unknown): SessionStats | null {
  if (isEmptyStatsBody(body)) return null;
  return body as SessionStats;
}

export function StatsTab({
  featureId,
  sessionStatus,
}: StatsTabProps): JSX.Element {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `visible` is read from `document.visibilityState` to gate the interval
  // per R33 / spec §5 (no polling while the tab is hidden).
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === 'undefined'
      ? true
      : document.visibilityState !== 'hidden',
  );

  // Track the latest in-flight fetch so a stale response from a previous
  // featureId/status can't clobber a newer one.
  const seqRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    if (!featureId) return;
    const mySeq = ++seqRef.current;
    try {
      const res = await fetch(
        `/api/agent/${encodeURIComponent(featureId)}/stats`,
        { method: 'GET', headers: { Accept: 'application/json' } },
      );
      if (mySeq !== seqRef.current) return;
      if (!res.ok) {
        setError(`Stats fetch failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as unknown;
      if (mySeq !== seqRef.current) return;
      setStats(asSessionStats(body));
      setError(null);
    } catch (err) {
      if (mySeq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [featureId]);

  // Visibility listener — flips the gating boolean. Bound once for the
  // lifetime of the component so it doesn't churn alongside the polling
  // effect.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // One-shot refresh on mount, featureId change, and session-status change
  // (R33 explicitly calls these out as the non-poll refresh triggers).
  useEffect(() => {
    void fetchOnce();
  }, [fetchOnce, sessionStatus]);

  // Polling effect — only runs while the tab is mounted AND visible AND
  // the session is `running`. Otherwise we rely on the one-shot effect
  // above for refreshes.
  useEffect(() => {
    if (!visible || sessionStatus !== 'running') return;
    const id = window.setInterval(() => {
      void fetchOnce();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchOnce, sessionStatus, visible]);

  return (
    <div className="stats-body flex flex-col gap-3.5 px-3.5 py-3 overflow-y-auto">
      {error ? <StatsError message={error} /> : null}
      <CostAndTokensSection stats={stats} />
      <ConversationSection stats={stats} />
      <ToolsUsedSection stats={stats} />
      <FilesTouchedSection stats={stats} />
      <SubagentsSection stats={stats} />
    </div>
  );
}

export default StatsTab;

/* ────────────────────────────────────────────────────────────────────── */
/*  Sections                                                              */
/* ────────────────────────────────────────────────────────────────────── */

function SectionShell({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className="stats-section bg-white border border-line rounded-lg p-3 shadow-sm"
      aria-labelledby={id}
    >
      <h4
        id={id}
        className="text-[12.5px] font-semibold text-ink-900 mb-2 mt-0"
      >
        {title}
      </h4>
      {children}
    </section>
  );
}

/* — 1. Cost & tokens — */

/**
 * Render the absolute USD cost with four decimal places. Spec pins the
 * format at `$0.0000` to give visibility into sub-cent costs that matter
 * for early-orchestrator runs.
 */
function formatCostUsd(costUsd: number | undefined): string {
  if (!Number.isFinite(costUsd)) return '$0.0000';
  return `$${(costUsd as number).toFixed(4)}`;
}

/**
 * Cache-hit percentage = cacheRead / (cacheCreation + cacheRead + input).
 * Renders `XX%` rounded to the nearest integer; falls back to `—` when the
 * denominator is 0.
 */
function formatCacheHitPct(stats: SessionStats | null): string {
  if (!stats) return EM_DASH;
  const denom =
    stats.cacheCreationTokens + stats.cacheReadTokens + stats.inputTokens;
  if (denom <= 0) return EM_DASH;
  const pct = (stats.cacheReadTokens / denom) * 100;
  return `${Math.round(pct)}%`;
}

function formatTokenCount(n: number | undefined): string {
  // Render small counts as integers and large counts as `12.3k` / `1.2M` so
  // the four-tile row stays narrow even on a 360px-wide drawer.
  if (!Number.isFinite(n) || (n as number) <= 0) return '0';
  const v = n as number;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

function CostAndTokensSection({
  stats,
}: {
  stats: SessionStats | null;
}): JSX.Element {
  return (
    <SectionShell id="s-cost" title="Cost & tokens">
      <div className="tile-row grid grid-cols-4 gap-2">
        <StatsTile value={formatCostUsd(stats?.costUsd)} label="Cost (USD)" />
        <StatsTile
          value={formatTokenCount(stats?.inputTokens)}
          label="Input tokens"
        />
        <StatsTile
          value={formatTokenCount(stats?.outputTokens)}
          label="Output tokens"
        />
        <StatsTile value={formatCacheHitPct(stats)} label="Cache hit %" />
      </div>
    </SectionShell>
  );
}

/* — 2. Conversation — */

function ConversationSection({
  stats,
}: {
  stats: SessionStats | null;
}): JSX.Element {
  const turns = stats?.turns ?? 0;
  const wall = formatWallClock(stats?.wallClockMs ?? 0);
  return (
    <SectionShell id="s-conv" title="Conversation">
      <div className="tile-row tile-row--two grid grid-cols-2 gap-2">
        <StatsTile value={String(turns)} label="Turns" />
        <StatsTile value={wall} label="Wall-clock" />
      </div>
    </SectionShell>
  );
}

/* — 3. Tools used (chip row) — */

/**
 * Map a tool name to a chip palette class per spec §5 / §6.10.
 *
 *   blue   (.chip.phase-implement) — read-family tools that inspect or
 *                                    modify files locally (Read, Glob,
 *                                    Edit, Write, NotebookEdit, MultiEdit).
 *   purple (.chip.mixed)           — Task (subagent dispatch).
 *   amber  (.chip.infra)           — Grep, search-family tools.
 *   green  (.chip.st-done)         — WebFetch / WebSearch / network reads.
 *   gray   (.chip.st-none)         — everything else (Bash, custom tools).
 */
function chipClassForTool(name: string): string {
  const READ_FAMILY = new Set([
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Glob',
    'NotebookEdit',
    'NotebookRead',
    'TodoWrite',
  ]);
  if (name === 'Task') return 'chip mixed';
  if (name === 'Grep') return 'chip infra';
  if (name === 'WebFetch' || name === 'WebSearch') return 'chip st-done';
  if (READ_FAMILY.has(name)) return 'chip phase-implement';
  return 'chip st-none';
}

function sortedToolCalls(
  toolCalls: Record<string, ToolCallStat> | undefined,
): Array<[string, ToolCallStat]> {
  if (!toolCalls) return [];
  return Object.entries(toolCalls).sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0]);
  });
}

function ToolsUsedSection({
  stats,
}: {
  stats: SessionStats | null;
}): JSX.Element {
  const rows = useMemo(() => sortedToolCalls(stats?.toolCalls), [stats]);
  return (
    <SectionShell id="s-tools" title="Tools used">
      {rows.length === 0 ? (
        <EmptyLine>No tools called yet.</EmptyLine>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {rows.map(([name, stat]) => (
            <span
              key={name}
              className={chipClassForTool(name)}
              title={`${name}: ${stat.count} call${
                stat.count === 1 ? '' : 's'
              }, total ${formatToolDuration(stat.totalDurationMs)}`}
            >
              {name} · {stat.count}
            </span>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

/* — 4. Files touched — */

/**
 * Build the `vscode://file/<path>` href. We prefer an absolute path when
 * the session manager fed us one; relative paths still work because VS Code
 * resolves them against the currently-open workspace.
 */
function vscodeHref(path: string): string {
  return `vscode://file/${path}`;
}

function fallbackFileHref(path: string): string {
  if (path.startsWith('/')) return `file://${path}`;
  return `file:///${path}`;
}

function sortedFilesTouched(
  files: Record<string, FileTouchStat> | undefined,
): Array<[string, FileTouchStat]> {
  if (!files) return [];
  return Object.entries(files).sort((a, b) => {
    const at = a[1].reads + a[1].edits;
    const bt = b[1].reads + b[1].edits;
    if (bt !== at) return bt - at;
    return a[0].localeCompare(b[0]);
  });
}

function FilesTouchedSection({
  stats,
}: {
  stats: SessionStats | null;
}): JSX.Element {
  const rows = useMemo(() => sortedFilesTouched(stats?.filesTouched), [stats]);

  const onLinkClick = useCallback(
    (path: string) =>
      (e: React.MouseEvent<HTMLAnchorElement>): void => {
        try {
          window.open(vscodeHref(path), '_blank', 'noopener,noreferrer');
        } catch {
          window.open(
            fallbackFileHref(path),
            '_blank',
            'noopener,noreferrer',
          );
        }
        e.preventDefault();
      },
    [],
  );

  return (
    <SectionShell id="s-files" title="Files touched">
      {rows.length === 0 ? (
        <EmptyLine>No files touched yet.</EmptyLine>
      ) : (
        <div className="flex flex-col">
          {rows.map(([path, stat]) => (
            <div
              key={path}
              className="file-row flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-ink-50"
            >
              <a
                href={vscodeHref(path)}
                onClick={onLinkClick(path)}
                title={path}
                className="mono text-[12px] text-ink-700 hover:text-ink-900 truncate flex-1 min-w-0 no-underline"
              >
                {path}
              </a>
              <span className="mono text-[11px] text-ink-500 whitespace-nowrap">
                {stat.reads} {stat.reads === 1 ? 'read' : 'reads'}
              </span>
              <span className="mono text-[11px] text-ink-500 whitespace-nowrap">
                {stat.edits} {stat.edits === 1 ? 'edit' : 'edits'}
              </span>
              {stat.lastTouchedAt ? (
                <span
                  className="text-[11px] text-ink-500 whitespace-nowrap"
                  title={stat.lastTouchedAt}
                >
                  {formatRelativeTime(stat.lastTouchedAt)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

/* — 5. Subagents — */

function sortedSubagents(
  subagents: Record<string, SubagentStat> | undefined,
): Array<[string, SubagentStat]> {
  if (!subagents) return [];
  return Object.entries(subagents).sort((a, b) => {
    if (b[1].dispatches !== a[1].dispatches) {
      return b[1].dispatches - a[1].dispatches;
    }
    return a[0].localeCompare(b[0]);
  });
}

/**
 * For each subagent column, the cell renders the formatted value when the
 * underlying numeric field is `> 0` and `—` otherwise. The SDK only
 * sometimes populates `usage` / `total_cost_usd` / `duration_ms` on a
 * `Task` result, so a zero counter is indistinguishable from "field was
 * omitted on every run" and we treat both the same way.
 */
function subagentCell(value: number, formatter: (n: number) => string): string {
  if (!Number.isFinite(value) || value <= 0) return EM_DASH;
  return formatter(value);
}

function SubagentsSection({
  stats,
}: {
  stats: SessionStats | null;
}): JSX.Element {
  const rows = useMemo(() => sortedSubagents(stats?.subagents), [stats]);
  return (
    <SectionShell id="s-agents" title="Subagents">
      {rows.length === 0 ? (
        <EmptyLine>No subagents dispatched.</EmptyLine>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map(([name, stat]) => (
            <div
              key={name}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-line bg-white"
            >
              <span className="text-[12px] font-semibold text-ink-900 truncate flex-1 min-w-0">
                {name}
              </span>
              <span
                className="mono text-[11px] text-ink-500 whitespace-nowrap"
                title="Dispatches"
              >
                ×{stat.dispatches > 0 ? stat.dispatches : 0}
              </span>
              <span
                className="mono text-[11px] text-ink-700 whitespace-nowrap"
                title="Cost (USD)"
              >
                {subagentCell(stat.costUsd, (n) => `$${n.toFixed(4)}`)}
              </span>
              <span
                className="mono text-[11px] text-ink-500 whitespace-nowrap"
                title="Duration"
              >
                {subagentCell(stat.durationMs, formatWallClock)}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Shared atoms                                                          */
/* ────────────────────────────────────────────────────────────────────── */

function EmptyLine({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="m-0 text-[12.5px] text-ink-500 italic">{children}</p>
  );
}

function StatsError({ message }: { message: string }): JSX.Element {
  return (
    <p role="status" className="m-0 text-[12px] text-red-700">
      {message}
    </p>
  );
}
