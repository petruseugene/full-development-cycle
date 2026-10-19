'use client';

import { useEffect, useRef, useState } from 'react';

export function NewFeatureModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setPrompt('');
      setSubmitting(false);
      setToast(null);
      setError(null);
      setTimeout(() => taRef.current?.focus(), 50);
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

  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setToast('Queued — orchestrator picks this up next.');
      setTimeout(() => {
        setToast(null);
        onClose();
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 cmdk-bg flex items-start justify-center pt-[16vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[520px] rounded-xl border border-line bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-line">
          <span className="text-[13px] font-semibold text-ink-900">New feature</span>
          <span className="ml-auto kbd">esc</span>
        </div>
        <div className="p-3.5">
          <textarea
            ref={taRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Describe the feature, bug, or task…"
            className="w-full resize-none rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] text-ink-900 placeholder:text-ink-400 outline-none focus:border-primary"
          />
          {toast && (
            <div className="mt-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink-700">
              {toast}
            </div>
          )}
          {error && (
            <div className="mt-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-rose-600">
              {error}
            </div>
          )}
        </div>
        <div className="px-3.5 py-2.5 border-t border-line flex items-center gap-2">
          <span className="ml-auto" />
          <button
            onClick={onClose}
            className="h-8 px-3 rounded-md border border-line bg-white text-[13px] text-ink-700 hover:bg-ink-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="h-8 px-3 rounded-md bg-primary text-white text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
