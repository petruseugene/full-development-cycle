'use client';

import { useSnapshot } from '@/lib/snapshot-context';
import { STATUS_DOT } from '@/components/Sidebar';

// `HistoryEvent.status` is `string`, not `TaskStatus`, so we cannot index
// `STATUS_DOT` directly. Bridge common subagent verdicts to the dot classes
// defined in `dashboard/app/globals.css` (.sd.done / .sd.blocked /
// .sd.progress / .sd.testing / .sd.todo).
function dotFor(status: string): string {
  const s = status.toUpperCase();
  if (s === 'DONE' || s === 'APPROVED' || s === 'PASSED') return STATUS_DOT.DONE;
  if (s === 'FAILED' || s === 'CHANGES_REQUIRED' || s === 'BLOCKED') return STATUS_DOT.BLOCKED;
  return STATUS_DOT.IN_PROGRESS;
}

// Collapse "implement.task=1" / "review.task=3" / "static-check.task=2" /
// "visual-test" / "git.branch" / "commit.task=2" into a clean phase token
// matching the `.chip.phase-*` variants in globals.css.
function phaseLabel(phase: string): string {
  const head = phase.split(/[.=]/)[0];
  return head;
}

function phaseChipClass(phase: string): string {
  return `chip phase-${phaseLabel(phase)}`;
}

function statusChipClass(status: string): string {
  return `chip st-${status.toLowerCase()}`;
}

// "Xm Ys" / "Xm" / "Ys" — mirrors the wireframe's dur column.
function durationLabel(s: number | undefined): string {
  if (s == null || s <= 0) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(d: Date, today: Date, yesterday: Date): string {
  const k = dayKey(d);
  if (k === dayKey(today)) return 'Today';
  if (k === dayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function ActivityPage() {
  const { snapshot } = useSnapshot();
  if (snapshot == null) return null;

  const events = snapshot.features
    .flatMap((f) =>
      (f.meta?.history ?? []).map((h) => ({
        ...h,
        feature_slug: f.meta!.feature_slug,
        feature_title: f.title,
      })),
    )
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  const groups: { key: string; label: string; rows: typeof events }[] = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const ev of events) {
    const d = new Date(ev.ts);
    const k = dayKey(d);
    let group = groups[groups.length - 1];
    if (!group || group.key !== k) {
      group = { key: k, label: dayLabel(d, today, yesterday), rows: [] };
      groups.push(group);
    }
    group.rows.push(ev);
  }

  return (
    <main className="flex-1 min-w-0 px-6 py-4">
      <header className="flex items-baseline gap-2.5 mb-4">
        <h1 className="text-[13px] font-semibold text-ink-900">Activity</h1>
        <span className="text-[12px] text-ink-500">{events.length}</span>
      </header>

      {events.length === 0 ? (
        <p className="text-[12px] text-ink-500">No activity yet</p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <div key={g.key} className="flex flex-col gap-1">
              <div className="mono text-[10.5px] uppercase tracking-wider text-ink-500 mb-1">
                {g.label}
                <span className="ml-2 text-ink-400">{g.rows.length}</span>
              </div>
              <ol role="list" className="flex flex-col gap-px">
                {g.rows.map((h, idx) => {
                  const d = new Date(h.ts);
                  const dur = durationLabel(h.duration_s);
                  return (
                    <li
                      key={`${h.feature_slug}-${h.ts}-${idx}`}
                      className="event-row grid items-center gap-3 px-3 py-2 rounded-md border border-transparent hover:bg-white hover:border-line"
                    >
                      <span className="mono text-[10.5px] text-ink-500">
                        {timeLabel(d)}
                      </span>
                      <span className={'sd ' + dotFor(h.status)} aria-hidden="true" />
                      <span className="text-[13px] text-ink-700 truncate">
                        <span className="mono text-ink-900 font-medium">{h.subagent}</span>
                        <span className="text-ink-400 mx-1">→</span>
                        {h.status} on{' '}
                        <span className="text-ink-900 font-medium">{h.feature_title}</span>
                      </span>
                      <span className="slug-pill">{h.feature_slug}</span>
                      <span className="event-model">
                        {typeof h.model === 'string' && h.model.trim() ? (
                          <span className="chip model">{h.model}</span>
                        ) : null}
                      </span>
                      <span className={phaseChipClass(h.phase)}>{phaseLabel(h.phase)}</span>
                      <span className={statusChipClass(h.status)}>{h.status}</span>
                      <span className="dur">{dur}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
