'use client';

import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useSnapshot } from '@/lib/snapshot-context';
import type { Feature, Task } from '@/lib/types';
import { parseAcceptanceItems, parseFileItem } from '@/lib/task-fields';
import { parseAcceptanceRef, type SpecId } from '@/lib/spec-ids';
import { InlineMd } from './InlineMd';

// Per spec §4.9 (R45–R50) + wireframes/task-modal.html. Refactored from the
// legacy right-rail TaskDrawer into a centered modal so the right rail is
// owned exclusively by the chat drawer (delivered in Task 10). Structure
// matches wireframes/task-modal.html column-for-column; visual styling
// reuses existing primitives (.chip, .slug-pill, .sd, Tailwind utilities)
// per R50 — no new global CSS classes are introduced.

// AC38 binds the scrim background to exactly rgba(0,0,0,.36). The existing
// `.scrim` / `.cmdk-bg` classes use other rgba values, so we inline the
// binding color here rather than ship a new global class.
const SCRIM_BG = 'rgba(0,0,0,0.36)';

// Selector for focusable children inside the modal (focus trap).
const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable=true]';

export function TaskModal({
  open,
  task,
  feature,
  onClose,
}: {
  open: boolean;
  task: Task | null;
  feature: Feature | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const modalRef = useRef<HTMLDivElement | null>(null);
  // Saved on open, restored on close (R46).
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Autofocus target for AC43: the right-most "Close" button.
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // Save the previously-focused element when the modal opens; restore on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null;
    // Focus the autofocus Close button on the next frame so the browser
    // doesn't move focus elsewhere mid-mount.
    const id = window.setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      // Restore focus to the opener (e.g., the task card the user clicked).
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open]);

  // Escape closes; Tab / Shift+Tab cycle within the modal (R46).
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = modalRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [open, onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onKeyDown]);

  const dependsOn = useMemo(() => {
    // plan.md lists "Depends on" but the runtime Task shape doesn't carry
    // that field; render "—" rather than fabricate.
    return '—';
  }, []);

  if (!open) return null;

  const slug = feature?.slug ?? '';
  const phase = feature?.meta?.current_phase ?? null;
  const phaseClass = phase ? `chip phase-${phase}` : 'chip';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      role="presentation"
      style={{ background: SCRIM_BG }}
      onMouseDown={(e) => {
        // Scrim click closes — only when the mousedown originated on the
        // scrim itself, not on a descendant of the modal.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white border border-line shadow-2xl rounded-xl overflow-hidden flex flex-col"
        style={{ width: 'min(720px, 90vw)', maxHeight: '85vh' }}
      >
        {task && feature ? (
          <Body
            task={task}
            feature={feature}
            titleId={titleId}
            slug={slug}
            phase={phase}
            phaseClass={phaseClass}
            dependsOn={dependsOn}
            onClose={onClose}
            closeBtnRef={closeBtnRef}
          />
        ) : (
          <div className="p-6 text-[13px] text-ink-500">
            <div className="flex items-center justify-end">
              <button
                ref={closeBtnRef}
                type="button"
                onClick={onClose}
                className="h-8 px-3 rounded-md bg-primary text-white text-[13px] font-medium"
                autoFocus
              >
                Close
              </button>
            </div>
            <p className="mt-2">No task selected.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Backwards-compatibility alias — exported so any lingering import that
// references the legacy name still resolves while Task 10 finishes its
// rollout. Safe to remove in a follow-up.
export const TaskDrawer = TaskModal;

export default TaskModal;

function Body({
  task,
  feature,
  titleId,
  slug,
  phase,
  phaseClass,
  dependsOn,
  onClose,
  closeBtnRef,
}: {
  task: Task;
  feature: Feature;
  titleId: string;
  slug: string;
  phase: string | null;
  phaseClass: string;
  dependsOn: string;
  onClose: () => void;
  closeBtnRef: React.RefObject<HTMLButtonElement>;
}) {
  const { openChat, agentEnabled } = useSnapshot();
  const reviews = feature.reviews.filter((r) => r.taskId === task.id);
  const featureSlug = feature.slug;
  const agentLabel = agentLabelForTag(task.tag);
  const fileItems = (task.files ?? []).map(parseFileItem);
  const touches = fileItems.map((f) => f.path);
  const cycleCount = task.reviewCycles ?? 0;
  const acceptanceItems = parseAcceptanceItems(task.acceptance);
  const stepItems = task.stepItems ?? [];
  // Finished tasks show every step / criterion as complete, whatever the
  // `[ ]` still says in plan.md / spec.md.
  const allDone = task.status === 'DONE';
  // The card excerpt falls back to the first step when a task has no prose;
  // the modal lists the steps itself, so don't repeat a truncated copy.
  const description = (task.fullDescription ?? (stepItems.length ? '' : task.description ?? '')).trim();

  const onViewOnDisk = useCallback(() => {
    // Best-effort: open the feature folder in the user's editor via the
    // vscode:// handler, falling back to file://.
    const url = `vscode://file/${feature.folderPath}`;
    try {
      window.open(url, '_blank');
    } catch {
      window.open(`file://${feature.folderPath}`, '_blank');
    }
  }, [feature.folderPath]);

  // AC42 / F9 — Open chat: fan the user to the chat drawer for this task's
  // feature (same path as Board's per-card Chat CTA), then dismiss the modal
  // per R49 (chat drawer + task modal are not co-rendered).
  const onOpenChat = useCallback(() => {
    openChat(feature.id);
    onClose();
  }, [openChat, feature.id, onClose]);

  // Display slug — prefer the prop slug (mirrors the wireframe's
  // .slug-pill content); the closure variable below already covers it
  // but keeping a void-read silences unused-var warnings if the linter
  // ever flags the shadow.
  void slug;

  return (
    <>
      {/* Header — order per AC40:
          slug-pill → h2 → phase chip → status chip → spacer → close ✕ */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-line flex-wrap">
        <span className="slug-pill">{featureSlug}</span>
        <h2
          id={titleId}
          className="text-[16px] font-semibold tracking-tight text-ink-900 leading-tight"
        >
          <span className="mono text-[11px] text-ink-500 mr-2">
            {featureSlug.split('-').slice(-1)[0].toUpperCase()}-
            {task.index.toString().padStart(3, '0')}
          </span>
          {task.title}
        </h2>
        {phase ? <span className={phaseClass}>{phase}</span> : null}
        <StatusChip status={task.status} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task modal"
          className="selpill"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      {/* Body — AC41: <dl class="kv"> metadata + four sections */}
      <div className="flex-1 overflow-auto col-scroll px-5 py-4">
        <dl
          className="kv text-[13px]"
          style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '6px 12px' }}
        >
          <dt className="mono text-[10.5px] uppercase tracking-wider text-ink-500">Agent</dt>
          <dd className="text-ink-800">{agentLabel}</dd>

          <dt className="mono text-[10.5px] uppercase tracking-wider text-ink-500">Tag</dt>
          <dd>
            <span className={`chip ${task.tag}`}>{task.tag}</span>
          </dd>

          <dt className="mono text-[10.5px] uppercase tracking-wider text-ink-500">Depends on</dt>
          <dd className="text-ink-800">{dependsOn}</dd>

          <dt className="mono text-[10.5px] uppercase tracking-wider text-ink-500">Touches</dt>
          <dd className="mono text-[12px] text-ink-700 break-all">
            {touches.length > 0 ? touches.join(', ') : '—'}
          </dd>

          <dt className="mono text-[10.5px] uppercase tracking-wider text-ink-500">
            Cycle count
          </dt>
          <dd className="text-ink-800">{cycleCount} / 3</dd>
        </dl>

        {/* Four sections per AC41: Description, Acceptance, Related files, History */}
        <TaskDescription description={description} steps={stepItems} allDone={allDone} />

        <section className="mt-5">
          <h3 className="text-[13px] font-semibold text-ink-900 mb-1.5">Acceptance</h3>
          {acceptanceItems.length > 0 ? (
            <AcceptanceList items={acceptanceItems} specIds={feature.specIds} allDone={allDone} />
          ) : (
            <p className="text-[12.5px] text-ink-500">No acceptance criteria listed.</p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="text-[13px] font-semibold text-ink-900 mb-1.5">Related files</h3>
          {touches.length > 0 ? (
            <ul className="list-none p-0 m-0 flex flex-col gap-1">
              {fileItems.map(({ path: p, note }, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                  {/* AC42: vscode://file/<abs-path> with monospace + wavy underline. */}
                  <a
                    className="mono text-[12.5px] text-ink-800"
                    style={{ textDecoration: 'underline wavy #94A3B8' }}
                    href={`vscode://file/${joinPaths(feature.folderPath, p)}`}
                  >
                    {p}
                  </a>
                  {note ? (
                    <span className="text-[12px] text-ink-500">
                      <InlineMd text={note} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-500">No related files.</p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="text-[13px] font-semibold text-ink-900 mb-1.5">History</h3>
          {reviews.length === 0 && !(feature.meta?.history?.length ?? 0) ? (
            <p className="text-[12.5px] text-ink-500">No history recorded yet for this task.</p>
          ) : (
            <ul className="list-none p-0 m-0 flex flex-col gap-1.5 text-[12.5px] text-ink-700">
              {reviews.map((r, i) => (
                <li key={`r-${i}`}>
                  <span className="mono text-[11px] text-ink-500 mr-2">
                    {r.ts ? formatTime(r.ts) : ''}
                  </span>
                  code-reviewer · cycle {r.cycle} · {r.status}
                </li>
              ))}
              {(feature.meta?.history ?? [])
                .filter((ev) => !ev.task_id || ev.task_id === task.id)
                .slice(-8)
                .reverse()
                .map((ev, i) => (
                  <li key={`h-${i}`}>
                    <span className="mono text-[11px] text-ink-500 mr-2">
                      {formatTime(ev.ts)}
                    </span>
                    {ev.subagent} · {ev.phase} · {ev.status}
                    {typeof ev.model === 'string' && ev.model.trim() ? ` · ${ev.model}` : ''}
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>

      {/* Footer — AC43: right-aligned Open chat / View on disk / Close (autofocus) */}
      <div className="px-5 py-2.5 border-t border-line flex items-center justify-end gap-2">
        {agentEnabled ? (
          <button
            type="button"
            className="h-8 px-3 rounded-md border border-transparent text-[13px] text-ink-700 hover:bg-ink-50"
            onClick={onOpenChat}
          >
            Open chat
          </button>
        ) : null}
        <button
          type="button"
          className="h-8 px-3 rounded-md border border-line bg-white text-[13px] text-ink-700 hover:bg-ink-50"
          onClick={onViewOnDisk}
        >
          View on disk
        </button>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          className="h-8 px-3 rounded-md bg-primary text-white text-[13px] font-medium"
          autoFocus
        >
          Close
        </button>
      </div>
    </>
  );
}

function StatusChip({ status }: { status: Task['status'] }) {
  // Mirror the wireframe's `.chip.st-inprogress` for IN_PROGRESS plus the
  // existing primitives for the other statuses.
  const map: Record<
    Task['status'],
    { className: string; dot: string; label: string }
  > = {
    TODO: { className: '', dot: 'todo', label: 'to do' },
    IN_PROGRESS: { className: 'st-running', dot: 'progress', label: 'in progress' },
    IN_TESTING: { className: 'st-running', dot: 'testing', label: 'testing' },
    BLOCKED: { className: 'st-blocked', dot: 'blocked', label: 'blocked' },
    DONE: { className: 'st-done', dot: 'done', label: 'done' },
  };
  const s = map[status];
  return (
    <span className={`chip ${s.className}`}>
      <span className={`sd ${s.dot}`} /> {s.label}
    </span>
  );
}

function agentLabelForTag(tag: Task['tag']): string {
  switch (tag) {
    case 'frontend':
      return 'frontend-dev';
    case 'backend':
      return 'backend-dev';
    case 'mixed':
      return 'frontend-dev + backend-dev';
    case 'infra':
      return 'backend-dev';
  }
}

export function TaskDescription({
  description,
  steps,
  allDone,
}: {
  description: string;
  steps: { text: string; done: boolean }[];
  allDone?: boolean;
}) {
  if (!description && steps.length === 0) {
    return (
      <section className="mt-5">
        <h3 className="text-[13px] font-semibold text-ink-900 mb-1.5">Description</h3>
        <p className="text-[12.5px] text-ink-500">No description provided.</p>
      </section>
    );
  }
  return (
    <>
      {description ? (
        <section className="mt-5">
          <h3 className="text-[13px] font-semibold text-ink-900 mb-1.5">Description</h3>
          <p className="text-[13px] text-ink-700 leading-relaxed whitespace-pre-wrap">
            <InlineMd text={description} />
          </p>
        </section>
      ) : null}
      {steps.length > 0 ? (
        <section className="mt-5">
          <h3 className="text-[13px] font-semibold text-ink-900 mb-1.5">Steps</h3>
          <ul className="list-none p-0 m-0 flex flex-col gap-1 text-[13px] text-ink-700">
            {steps.map((st, i) => {
              const done = allDone || st.done;
              return (
                <li key={i} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={done}
                    readOnly
                    disabled
                    aria-label={done ? 'done' : 'not done'}
                    className="mt-1"
                  />
                  <span className={done ? 'text-ink-500' : ''}>
                    <InlineMd text={st.text} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function AcceptanceList({
  items,
  specIds,
  allDone,
}: {
  items: string[];
  specIds?: Record<string, SpecId>;
  allDone?: boolean;
}) {
  return (
    <ul className="list-none p-0 m-0 text-[13px] text-ink-700 space-y-2">
      {items.map((item, i) => {
        const ref = parseAcceptanceRef(item);
        if (!ref) {
          return (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span><InlineMd text={item} /></span>
            </li>
          );
        }
        const def = specIds?.[ref.id];
        return (
          <li key={i}>
            <div className="flex items-start gap-2">
              {allDone || def?.done !== undefined ? (
                <input type="checkbox" checked={allDone || !!def?.done} readOnly disabled aria-label={allDone || def?.done ? 'done' : 'not done'} className="mt-1" />
              ) : null}
              <span>
                <span className="mono text-[11.5px] font-semibold text-ink-900">{ref.id}</span>
                {def ? <> — <InlineMd text={def.text} /></> : null}
                {ref.rest ? <> <InlineMd text={ref.rest} /></> : null}
              </span>
            </div>
            {ref.refs.length > 0 ? (
              <ul className="list-none m-0 mt-1 ml-5 pl-3 border-l border-line space-y-1 text-[12.5px] text-ink-500">
                {ref.refs.map((r) => (
                  <li key={r}>
                    <span className="mono text-[11px] font-semibold text-ink-700">{r}</span>
                    {specIds?.[r] ? <> — <InlineMd text={specIds[r].text} /></> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function joinPaths(folder: string, p: string): string {
  // p may already be absolute or repo-relative. If it starts with `/`,
  // treat as absolute; otherwise prepend the feature folder.
  if (p.startsWith('/')) return p;
  if (!folder) return p;
  return folder.replace(/\/$/, '') + '/' + p.replace(/^\.?\//, '');
}
