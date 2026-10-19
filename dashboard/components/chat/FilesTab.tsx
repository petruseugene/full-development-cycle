'use client';

/**
 * FilesTab — chat-redesign Task 9.
 *
 * Renders the Files tabpanel of the ChatDrawer per the chat-redesign spec
 * (`docs/features/2026-05-17-22h-01m-chat-redesign/spec.md`, §6.11):
 *
 *   - List container: white card with subtle shadow.
 *   - One row per touched file: `[ext-tag] [mono path] [mono meta]`.
 *   - Click (or keyboard activation) opens the file via the existing
 *     `vscode://` → `file://` handler chain (the project's `editor://`
 *     open-in-editor contract — unchanged from the previous revision).
 *
 * Polling contract (R33 / AC5 — same gating as `StatsTab.tsx`):
 *   - Poll `GET /api/agent/[featureId]/stats` every 3 s while the component
 *     is mounted AND `document.visibilityState === 'visible'` AND
 *     `sessionStatus === 'running'`.
 *   - When any of those conditions flip, the interval is torn down. A
 *     one-shot fetch on featureId / sessionStatus change keeps the panel
 *     fresh on tab activation + session transitions even while polling is
 *     paused.
 *
 * All visual styling is Tailwind utility classes — no inline `style={...}`
 * objects, no handwritten/paper-aesthetic fonts, no kraft hex backgrounds.
 * The dashboard's `globals.css` provides `.mono`. Everything else is plain
 * Tailwind utilities matching `TaskCard.tsx`'s idiom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FileTouchStat, SessionStats } from '@/lib/agent/stats';
import {
  formatRelativeTime,
  formatWallClock,
} from '@/lib/agent/format';

const POLL_INTERVAL_MS = 3000;

/** Session-status values that gate live polling (mirror ChatDrawer.tsx). */
type SessionStatus =
  | 'no_session'
  | 'running'
  | 'idle'
  | 'awaiting_approval'
  | 'errored';

export interface FilesTabProps {
  featureId: string;
  sessionStatus: SessionStatus;
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Fetch + polling                                                       */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * The stats endpoint returns `{}` when `sessionManager.get(featureId)`
 * resolves to nothing. Use `startedAt` as the sentinel for "has session"
 * since every real `SessionStats` carries one and `{}` has no keys.
 */
function isEmptyStatsBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return true;
  return !('startedAt' in (body as Record<string, unknown>));
}

function asSessionStats(body: unknown): SessionStats | null {
  if (isEmptyStatsBody(body)) return null;
  return body as SessionStats;
}

export function FilesTab({
  featureId,
  sessionStatus,
}: FilesTabProps): JSX.Element {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `visible` gates polling via `document.visibilityState` per R33.
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === 'undefined'
      ? true
      : document.visibilityState !== 'hidden',
  );

  // Sequence guard so a stale in-flight response from a previous
  // featureId / status can't clobber a newer one.
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

  // Visibility listener — bound once for the component lifetime.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // One-shot refresh on mount, featureId change, or session-status change.
  useEffect(() => {
    void fetchOnce();
  }, [fetchOnce, sessionStatus]);

  // Polling effect — only while mounted AND visible AND `running`.
  useEffect(() => {
    if (!visible || sessionStatus !== 'running') return;
    const id = window.setInterval(() => {
      void fetchOnce();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchOnce, sessionStatus, visible]);

  const rows = useMemo(
    () => sortedFilesTouched(stats?.filesTouched),
    [stats],
  );
  const fileCount = rows.length;
  const wallClock = formatWallClock(stats?.wallClockMs ?? 0);

  return (
    <div
      className="files-body flex flex-col gap-2.5 overflow-y-auto px-3.5 py-3"
      role="tabpanel"
      aria-label="Files"
    >
      {error ? <FilesError message={error} /> : null}
      <FilesHeader fileCount={fileCount} wallClock={wallClock} />
      {fileCount === 0 ? (
        <EmptyLine>No files touched yet.</EmptyLine>
      ) : (
        <div className="files-list bg-white border border-line rounded-lg p-1.5 shadow-sm">
          {rows.map(([path, stat]) => (
            <FileRow key={path} path={path} stat={stat} />
          ))}
        </div>
      )}
    </div>
  );
}

export default FilesTab;

/* ────────────────────────────────────────────────────────────────────── */
/*  Header                                                                */
/* ────────────────────────────────────────────────────────────────────── */

function FilesHeader({
  fileCount,
  wallClock,
}: {
  fileCount: number;
  wallClock: string;
}): JSX.Element {
  // Pluralise "file" / "files" to match natural-language reading; the
  // wireframe shows `7 files touched this session` so the multi case is
  // canonical, but a 1-file session reads better as `1 file touched`.
  const fileWord = fileCount === 1 ? 'file' : 'files';
  return (
    <div className="files-head flex items-center gap-2 text-[12.5px] text-ink-500">
      <span className="flex-1">
        <strong className="text-ink-900 font-semibold">
          {fileCount} {fileWord}
        </strong>{' '}
        touched this session
      </span>
      <span className="mono text-[11px] text-ink-500">last {wallClock}</span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  File row                                                              */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Build the `vscode://file/<path>` href. Absolute paths get the leading
 * slash that VS Code's handler expects; relative paths are passed through
 * and resolved against the currently-open workspace by VS Code.
 */
function vscodeHref(path: string): string {
  return `vscode://file/${path}`;
}

/**
 * `file://` fallback used when the `vscode://` handler is unavailable.
 * Absolute paths get the three-slash root prefix; relative paths get four
 * slashes (the workspace-relative form most desktop file managers accept).
 */
function fallbackFileHref(path: string): string {
  if (path.startsWith('/')) return `file://${path}`;
  return `file:///${path}`;
}

function sortedFilesTouched(
  files: Record<string, FileTouchStat> | undefined,
): Array<[string, FileTouchStat]> {
  if (!files) return [];
  return Object.entries(files).sort((a, b) => {
    // Sort by `lastTouchedAt` descending — most-recently-touched first
    // (closest to the wireframe's chronological "14s ago" ordering).
    // Tie-break on total touch count, then on path for determinism.
    const aTs = Date.parse(a[1].lastTouchedAt);
    const bTs = Date.parse(b[1].lastTouchedAt);
    if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) {
      return bTs - aTs;
    }
    const aTotal = a[1].reads + a[1].edits;
    const bTotal = b[1].reads + b[1].edits;
    if (bTotal !== aTotal) return bTotal - aTotal;
    return a[0].localeCompare(b[0]);
  });
}

/**
 * Per-extension background utility for the 2-char ext tag, per spec §6.11.
 * Falls back to `bg-primary` for anything unmapped.
 */
function extTagBg(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  switch (ext) {
    case 'css':
      return 'bg-purple-600';
    case 'md':
      return 'bg-emerald-600';
    case 'ts':
    case 'tsx':
      return 'bg-blue-600';
    case 'json':
      return 'bg-amber-600';
    default:
      return 'bg-primary';
  }
}

/**
 * The 2-char uppercase content of the ext tag — derived from the path's
 * extension (e.g. `TS`, `MD`, `CS`), falling back to the first two chars
 * of the basename when the path has no extension.
 */
function extTagText(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const slash = lower.lastIndexOf('/');
  if (dot > slash && dot >= 0) {
    const ext = lower.slice(dot + 1);
    return ext.slice(0, 2).toUpperCase();
  }
  const base = lower.slice(slash + 1);
  return base.slice(0, 2).toUpperCase() || '··';
}

function FileRow({
  path,
  stat,
}: {
  path: string;
  stat: FileTouchStat;
}): JSX.Element {
  /**
   * Row click handler — opens the file via the existing `vscode://` →
   * `file://` chain. Same behavior the previous revision implemented;
   * only the visual chrome is changing in this task.
   */
  const openInEditor = useCallback(() => {
    const opened = window.open(vscodeHref(path), '_blank', 'noopener,noreferrer');
    // `window.open` returns `null` for blocked or unhandled protocols.
    if (opened === null) {
      try {
        window.open(fallbackFileHref(path), '_blank', 'noopener,noreferrer');
      } catch {
        // last-resort: the user's environment can't open files at all.
      }
    }
  }, [path]);

  const onClick = useCallback(() => {
    openInEditor();
  }, [openInEditor]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openInEditor();
      }
    },
    [openInEditor],
  );

  const lastTouched = stat.lastTouchedAt
    ? formatRelativeTime(stat.lastTouchedAt)
    : null;

  // Meta cluster — keep the reads/edits content (it's the data we have)
  // but render it in the §6.11 meta style: `mono text-[11px] text-ink-500`.
  // The leading bullet separates from the path visually.
  const metaParts: string[] = [];
  if (stat.reads > 0) metaParts.push(`${stat.reads}r`);
  if (stat.edits > 0) metaParts.push(`${stat.edits}e`);
  if (metaParts.length === 0) metaParts.push('new');
  if (lastTouched) metaParts.push(lastTouched);
  const meta = metaParts.join(' · ');

  return (
    <div
      className="file-row flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-ink-50 cursor-pointer"
      onClick={onClick}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
      title={path}
      aria-label={`Open ${path} in editor`}
    >
      <span
        className={`ext-tag mono text-[10px] font-bold text-white rounded-sm px-1.5 py-0.5 ${extTagBg(path)}`}
        aria-hidden="true"
      >
        {extTagText(path)}
      </span>
      <span className="path mono text-[12px] text-ink-700 truncate flex-1">
        {path}
      </span>
      <span className="meta mono text-[11px] text-ink-500 whitespace-nowrap">
        {meta}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Atoms                                                                 */
/* ────────────────────────────────────────────────────────────────────── */

function EmptyLine({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="m-0 text-[13px] text-ink-500 italic">{children}</p>
  );
}

function FilesError({ message }: { message: string }): JSX.Element {
  return (
    <p role="status" className="m-0 text-[12px] text-red-700">
      {message}
    </p>
  );
}
