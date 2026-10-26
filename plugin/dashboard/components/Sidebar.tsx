'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Feature, TaskStatus } from '@/lib/types';
import { AGENT_LIST, AgentBadge } from './AgentBadge';
import { useSnapshot } from '@/lib/snapshot-context';
import { isBugfixRow } from '@/lib/bugfixes';

export const STATUS_DOT: Record<TaskStatus, string> = {
  TODO: 'todo',
  IN_PROGRESS: 'progress',
  IN_TESTING: 'testing',
  BLOCKED: 'blocked',
  DONE: 'done',
};

function inFlightSummary(f: Feature): string {
  const inFlight = f.tasks.filter((t) => t.status === 'IN_PROGRESS' || t.status === 'IN_TESTING').length;
  const blocked = f.tasks.filter((t) => t.status === 'BLOCKED').length;
  if (blocked > 0) return `${f.tasks.length} tasks · ${blocked} blocked`;
  if (inFlight > 0) return `${f.tasks.length} tasks · ${inFlight} in flight`;
  if (f.derived.overallStatus === 'DONE') return `${f.tasks.length} tasks · merged`;
  if (f.tasks.length === 0) return f.meta?.current_phase ? `phase: ${f.meta.current_phase}` : 'queued';
  return `${f.tasks.length} tasks · queued`;
}

/**
 * Pinned-rail summary line (spec AC24):
 *   `<N> tasks · <phase summary>` — `<phase summary>` is the lowercase
 *   current_phase string; ` · blocked` is appended when the feature is
 *   currently blocked (any task BLOCKED or derived.overallStatus BLOCKED).
 * Examples: `5 tasks · implement`, `9 tasks · review`, `5 tasks · review · blocked`.
 */
function pinnedSummary(f: Feature): string {
  const count = f.tasks.length;
  const phase = (f.meta?.current_phase ?? 'queued').toLowerCase();
  const blocked =
    f.derived.overallStatus === 'BLOCKED' ||
    f.tasks.some((t) => t.status === 'BLOCKED');
  const base = `${count} tasks · ${phase}`;
  return blocked ? `${base} · blocked` : base;
}

export function Sidebar({
  features,
  activeId,
  onSelect,
  onSelectAll,
  pinnedSlugs = [],
  onOpenPinPicker,
  onUnpin,
}: {
  features: Feature[];
  // Kept for backward compatibility; route-aware active state is computed
  // via usePathname(). These props can be removed in a future cleanup.
  activeId: string | null;
  onSelect: (id: string) => void;
  onSelectAll: () => void;
  // Pinned-rail wiring (Task 4). Optional so legacy call-sites compile.
  pinnedSlugs?: string[];
  onOpenPinPicker?: () => void;
  onUnpin?: (slug: string) => void;
}) {
  const pathname = usePathname();
  // Context-driven active state survives across route transitions and is the
  // source of truth for the pinned rail's `.active` highlight (plan Task 4 §4).
  const { activeFeatureId, snapshot } = useSnapshot();

  const featureCount = features.length;
  const bugfixCount = features.filter((f) => isBugfixRow(f.meta)).length;
  const activityCount = features.reduce(
    (n, f) => n + (f.meta?.history?.length ?? 0),
    0,
  );
  const releasesCount = features.filter((f) => f.meta?.current_phase === 'done').length;
  // AC7: nav-count = agents with calls > 0; rides on the same snapshot
  // refetch the existing nav-counts use (no second subscription).
  const agentsActiveCount =
    snapshot?.agents?.filter((a) => a.calls > 0).length ?? 0;

  const isFeatures = pathname === '/';
  const isBugfixes = pathname === '/bugfixes';
  const isActivity = pathname === '/activity';
  const isReleases = pathname === '/releases';
  const isAgents = pathname === '/agents';
  const isReport = pathname === '/report' || (pathname?.startsWith('/report/') ?? false);

  // Derive pinned rows in pinnedSlugs order (most-recently-pinned first).
  // Stale slugs with no matching feature are silently dropped (spec AC16 / R15).
  // `pinned = true` is set on these per-render copies only (R26 / AC17) so the
  // server snapshot is never mutated.
  const pinnedFeatures: Feature[] = pinnedSlugs
    .map((slug) => features.find((f) => f.slug === slug))
    .filter((f): f is Feature => Boolean(f))
    .map((f) => ({ ...f, pinned: true }));

  const showRail = isFeatures;
  const hasPins = pinnedFeatures.length > 0;

  return (
    <aside
      className="w-[232px] shrink-0 border-r border-line bg-white sticky top-12 self-start"
      style={{ height: 'calc(100vh - 48px)' }}
    >
      <div className="p-3 flex flex-col gap-0.5 h-full overflow-auto">
        <div className="px-2 pt-1 pb-1 text-[10.5px] uppercase tracking-wider mono text-ink-400">
          Workspace
        </div>

        <Link
          href="/"
          className={'nav-item' + (isFeatures ? ' active' : '')}
          aria-current={isFeatures ? 'page' : undefined}
          onClick={onSelectAll}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          Board <span className="nav-count">{featureCount}</span>
        </Link>

        <Link
          href="/bugfixes"
          className={'nav-item' + (isBugfixes ? ' active' : '')}
          aria-current={isBugfixes ? 'page' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 8v4l2 2" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          Bugfixes <span className="nav-count">{bugfixCount}</span>
        </Link>

        <Link
          href="/activity"
          className={'nav-item' + (isActivity ? ' active' : '')}
          aria-current={isActivity ? 'page' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 12h4l2-7 4 14 2-7h6" />
          </svg>
          Activity <span className="nav-count">{activityCount}</span>
        </Link>

        <Link
          href="/releases"
          className={'nav-item' + (isReleases ? ' active' : '')}
          aria-current={isReleases ? 'page' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 2v4M16 2v4M3 10h18" />
          </svg>
          Releases <span className="nav-count">{releasesCount}</span>
        </Link>

        <Link
          href="/agents"
          className={'nav-item' + (isAgents ? ' active' : '')}
          aria-current={isAgents ? 'page' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
          </svg>
          Agents <span className="nav-count">{agentsActiveCount}</span>
        </Link>

        <Link
          href="/report/index.html"
          className={'nav-item' + (isReport ? ' active' : '')}
          aria-current={isReport ? 'page' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <path d="M14 3v6h6M8 13h8M8 17h5" />
          </svg>
          Report
        </Link>

        {/* ============ PINNED FEATURES SECTION (spec §R14–R20; ACs 18–33) ============
            Visible only on `/` (R14 / AC15). The section header — including the
            `+` button — renders identically in both populated and empty states
            (AC33). The list is replaced by `.pinned-empty` when the persisted
            slug list yields zero matching features (AC1 / AC31). */}
        {showRail && (
          <section
            className="pinned-section"
            aria-labelledby="pinned-features-heading"
          >
            <header className="pinned-header">
              <span className="pinned-label" id="pinned-features-heading">
                PINNED FEATURES
              </span>
              <button
                type="button"
                className="pin-add-btn"
                aria-label="Pin a feature"
                title="Pin a feature"
                onClick={() => onOpenPinPicker?.()}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </header>

            {hasPins ? (
              <ul className="pinned-list" role="list">
                {pinnedFeatures.map((f) => {
                  const isActive = f.id === (activeFeatureId ?? activeId);
                  const dotClass = STATUS_DOT[f.derived.overallStatus];
                  return (
                    <li
                      key={f.id}
                      className={'pinned-row' + (isActive ? ' active' : '')}
                      data-slug={f.slug}
                      onClick={() => onSelect(f.id)}
                    >
                      <span className={'sd ' + dotClass} aria-hidden="true" />
                      <div className="pinned-body">
                        <div className="pinned-title">{f.title}</div>
                        <div className="pinned-summary mono">{pinnedSummary(f)}</div>
                      </div>
                      <button
                        type="button"
                        className="pin-remove-btn"
                        aria-label={`Unpin ${f.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onUnpin?.(f.slug);
                        }}
                        onKeyDown={(e) => {
                          // Keep Enter/Space activation isolated from the row's
                          // onClick so `onSelect` is not triggered (R19 / AC9).
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                          }
                        }}
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          aria-hidden="true"
                        >
                          <path d="M6 6l12 12M6 18L18 6" />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="pinned-empty">
                Nothing pinned <span className="pinned-empty-sep">·</span> click{' '}
                <span className="mono">+</span> to pin a feature
              </p>
            )}
          </section>
        )}

        {/* [DECORATIVE] not interactive, kept for visual rhythm */}
        <div className="mt-auto pt-4">
          <div className="rounded-md border border-line p-2.5">
            <div className="text-[10.5px] uppercase tracking-wider mono text-ink-400 mb-1.5">
              Agents online
            </div>
            <div className="flex flex-wrap gap-1">
              {AGENT_LIST.map((name) => (
                <AgentBadge key={name} name={name} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
