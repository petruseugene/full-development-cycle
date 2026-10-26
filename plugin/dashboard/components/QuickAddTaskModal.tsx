'use client';

import { useEffect, useId, useRef, useState } from 'react';

type Tag = 'frontend' | 'backend' | 'mixed' | 'infra' | 'owner' | 'content';

const TAGS: Tag[] = ['frontend', 'backend', 'mixed', 'infra', 'owner', 'content'];

export type QuickAddTaskModalProps = {
  open: boolean;
  onClose: () => void;
  featureId: string;
  featureSlug: string;
  featureTitle: string;
  currentPhase: string | null;
  onSuccess?: () => void;
};

export function QuickAddTaskModal({
  open,
  onClose,
  featureId,
  featureSlug,
  featureTitle,
  currentPhase,
  onSuccess,
}: QuickAddTaskModalProps) {
  const headerId = useId();
  const errorId = useId();
  const tagLabelId = useId();
  const titleInputId = useId();
  const descInputId = useId();

  const [title, setTitle] = useState('');
  const [tag, setTag] = useState<Tag>('mixed');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<{ status: number; message: string } | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setTag('mixed');
      setDescription('');
      setSubmitting(false);
      setServerError(null);
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;
  const showWarning = currentPhase != null && currentPhase !== 'done';

  // featureTitle is read so the prop is consumed (parent uses it for aria;
  // we keep the ref in case future ACs anchor copy on the feature title).
  void featureTitle;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const trimmedDesc = description.trim();
      const body: { title: string; tag: Tag; description?: string } = {
        title: trimmedTitle,
        tag,
      };
      if (trimmedDesc.length > 0) {
        body.description = description;
      }
      const res = await fetch(`/api/features/${featureId}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        onSuccess?.();
        onClose();
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setServerError({
        status: res.status,
        message: j.error ?? `HTTP ${res.status}`,
      });
      setSubmitting(false);
    } catch (e) {
      setServerError({
        status: 0,
        message: e instanceof Error ? e.message : String(e),
      });
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 cmdk-bg flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headerId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[520px] rounded-xl border border-line bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-line">
          <span id={headerId} className="text-[13px] font-semibold text-ink-900">
            Add task
          </span>
          <span className="mono text-[10.5px] text-ink-500">→ {featureSlug}</span>
          <span className="ml-auto kbd">esc</span>
        </div>

        {/* Body */}
        <div className="p-3.5 flex flex-col gap-3">
          {/* Title */}
          <div>
            <label
              htmlFor={titleInputId}
              className="block mono text-[10.5px] uppercase tracking-wider text-ink-500 mb-1"
            >
              Title <span className="text-red-700 ml-0.5">(required)</span>
            </label>
            <input
              ref={titleRef}
              id={titleInputId}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="What needs to be done?"
              aria-required="true"
              aria-invalid={serverError ? true : undefined}
              aria-describedby={serverError ? errorId : undefined}
              className="w-full rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] text-ink-900 placeholder:text-ink-400 outline-none focus:border-primary"
            />
            {serverError && (
              <div
                id={errorId}
                role="alert"
                className="mt-1.5 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-rose-600 flex items-start gap-1.5"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  aria-hidden="true"
                  className="mt-[2px] flex-none"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
                <span>
                  <span className="font-bold">{serverError.status}</span>
                  &nbsp;&nbsp;{serverError.message}
                </span>
              </div>
            )}
          </div>

          {/* Tag chip group */}
          <div>
            <span
              id={tagLabelId}
              className="block mono text-[10.5px] uppercase tracking-wider text-ink-500 mb-1"
            >
              Tag <span className="text-red-700 ml-0.5">(required)</span>
            </span>
            <div role="group" aria-labelledby={tagLabelId} className="inline-flex flex-wrap gap-1.5">
              {TAGS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip ${t}`}
                  aria-pressed={tag === t}
                  onClick={() => setTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor={descInputId}
              className="block mono text-[10.5px] uppercase tracking-wider text-ink-500 mb-1"
            >
              Description{' '}
              <span className="mono normal-case tracking-normal text-ink-400">
                (optional, max 1000)
              </span>
            </label>
            <textarea
              id={descInputId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder="Optional — appended as a `### Task N` section under `## Task details` in plan.md."
              className="w-full resize-none rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] text-ink-900 placeholder:text-ink-400 outline-none focus:border-primary"
            />
          </div>

          {/* Warning banner — currentPhase non-null and != 'done' */}
          {showWarning && (
            <div
              role="alert"
              className="rounded-md border border-amber-200 bg-amber-50 text-amber-700 px-3 py-2.5 text-[12.5px] leading-relaxed flex items-start gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
                className="mt-[1px] flex-none"
              >
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              <span>
                Orchestrator is running on this feature (phase: {currentPhase}). Your task will be
                added to the task list (<strong>plan.md</strong> or spec.md <strong>## Tasks</strong>) immediately and may interleave with the
                orchestrator&apos;s edits. Continue?
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-3.5 py-2.5 border-t border-line flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md border border-line bg-white text-[13px] text-ink-700 hover:bg-ink-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={submit}
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
            className="h-8 px-3 rounded-md bg-primary text-white text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}
