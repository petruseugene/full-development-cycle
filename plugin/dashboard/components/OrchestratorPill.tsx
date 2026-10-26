'use client';

import { useEffect, useRef, useState } from 'react';
import { useSnapshot } from '@/lib/snapshot-context';
import type { Feature, FeatureJson } from '@/lib/types';

type RunningPhase = Exclude<FeatureJson['current_phase'], 'done'>;

// Phase label maps. The two maps are identical EXCEPT for the `implement`
// phase: the pill chip (AC28, wireframe-bound) reads `Implement`, while the
// popover phase line (AC17, gerund form) reads `Implementing`. The `done`
// slot is defensive in both — running-detection gates it out before render.
const PHASE_LABEL_CHIP: Record<FeatureJson['current_phase'], string> = Object.freeze({
  discovery: 'Discovery',
  spec: 'Spec writing',
  wireframe: 'Wireframing',
  plan: 'Planning',
  implement: 'Implement', // AC28 — wireframe-bound chip label
  review: 'Reviewing',
  test: 'Testing',
  git: 'Shipping',
  done: 'Done', // never rendered — gated out by running detection
});

const PHASE_LABEL_POPOVER: Record<FeatureJson['current_phase'], string> = Object.freeze({
  discovery: 'Discovery',
  spec: 'Spec writing',
  wireframe: 'Wireframing',
  plan: 'Planning',
  implement: 'Implementing', // AC17 — gerund form for popover phase line
  review: 'Reviewing',
  test: 'Testing',
  git: 'Shipping',
  done: 'Done', // never rendered — gated out by running detection
});

const POPOVER_ID = 'orchestrator-status-popover';

/**
 * Pure formatter for the elapsed-time slot (AC12–AC15).
 *
 *   < 60s     → "Xs"          (AC12, e.g. "42s")
 *   < 3600s   → "Ym ZZs"      (AC13, e.g. "12m 04s")
 *   >= 3600s  → "Hh MMm"      (AC14, e.g. "3h 07m")
 *
 * Returns "—" when `created` is missing, empty, or unparseable (AC15).
 * `created` is the "YYYY-MM-DD HH:mm" string from feature.json.
 */
export function formatElapsed(created: string | null | undefined, nowMs: number): string {
  if (!created) return '—';
  const parsed = new Date(created.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return '—';
  const diffSec = Math.max(0, Math.floor((nowMs - parsed.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60);
    const s = String(diffSec % 60).padStart(2, '0');
    return `${m}m ${s}s`;
  }
  const h = Math.floor(diffSec / 3600);
  const m = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
  return `${h}h ${m}m`;
}

function isRunning(f: Feature): boolean {
  const phase = f.meta?.current_phase;
  return phase != null && phase !== 'done';
}

export default function OrchestratorPill() {
  const { snapshot } = useSnapshot();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Outside-mousedown + Escape close. Mirrors FiltersPopover.tsx.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Refresh elapsed once per minute while the popover is open (R11 / AC18).
  // Zero timers when closed or unmounted.
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now()); // immediate refresh on open
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [open]);

  if (snapshot == null) return null;

  // Running detection (R4 / AC4) and lex-max selection (R5 / AC4).
  // `snapshot.features` is non-nullable per DashboardSnapshot in lib/types.ts.
  const running = snapshot.features.filter(isRunning);
  const idle = running.length === 0;
  // In the running branch `target` is non-null; the idle branch never reads it.
  const target = idle
    ? null
    : [...running].sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  const meta = target ? target.meta : null;
  const phase = (meta?.current_phase ?? null) as RunningPhase | null;

  const toggle = () => setOpen((o) => !o);

  return (
    <div ref={wrapperRef} className="status-pill-wrap relative">
      {idle ? (
        // ===== Idle pill (R2 / AC2 / AC24 / AC25) =====
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={POPOVER_ID}
          aria-label="Orchestrator status: idle"
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-line bg-white hover:bg-ink-50 text-[12px] text-ink-600"
        >
          {/* AC2 + AC24: single .sd dot, no .progress, no .pulse-dot.
              Wireframe class set is `sd done`; inline background overrides
              the .done green so the dot reads as the muted/gray slot. */}
          <span
            className="sd done"
            aria-hidden="true"
            style={{ background: '#94A3B8' }}
          />
          <span className="text-[#64748B]">Idle</span>
        </button>
      ) : (
        // ===== Running pill (R3 / AC3 / AC26 / AC27 / AC28) =====
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={POPOVER_ID}
          aria-label={`Orchestrator running on ${meta?.feature_slug ?? ''}, phase ${
            phase ? PHASE_LABEL_CHIP[phase] : ''
          }`}
          className="inline-flex items-center gap-2 h-8 px-2.5 rounded-md border border-line bg-white hover:bg-ink-50 text-[12px] font-medium text-ink-900"
        >
          {/* AC26 order #1 — pulsing live dot */}
          <span className="sd progress pulse-dot rounded-full" aria-hidden="true" />
          {/* AC26 order #2 — slug pill */}
          <span className="slug-pill">{meta?.feature_slug}</span>
          {/* AC26 order #3 — phase chip */}
          {phase ? (
            <span className={`chip phase-${phase}`}>{PHASE_LABEL_CHIP[phase]}</span>
          ) : null}
        </button>
      )}

      {open ? (
        <div
          id={POPOVER_ID}
          role="dialog"
          aria-label="Orchestrator status"
          className="absolute top-full mt-1 right-0 z-20 w-[280px] rounded-md border border-line bg-white shadow-lg p-3 text-[12.5px] text-ink-900"
        >
          {idle || !meta ? (
            // ===== Popover (idle) — R7 / AC9 =====
            <div>Orchestrator is idle.</div>
          ) : (
            // ===== Popover (running) — R8 / AC10 / AC32 / AC33 / AC34 / AC35 =====
            <>
              {/* Header (AC32): slug + phase chip, gap-2 (8px) */}
              <div className="flex items-center gap-2 mb-2">
                <span className="slug-pill">{meta.feature_slug}</span>
                {phase ? (
                  <span className={`chip phase-${phase}`}>{PHASE_LABEL_POPOVER[phase]}</span>
                ) : null}
              </div>

              {/* Body — Task line (AC33) + Elapsed line (AC34) */}
              <div className="flex flex-col gap-1">
                {meta.task_count > 0 ? (
                  <div className="flex gap-1.5">
                    <span className="text-[#64748B]">Task</span>
                    <span className="font-bold">
                      {(meta.current_task_idx ?? 0) + 1}/{meta.task_count}
                    </span>
                  </div>
                ) : null}
                <div className="flex gap-1.5">
                  <span className="text-[#64748B]">Elapsed:</span>
                  <span className="font-mono tabular-nums">
                    {formatElapsed(meta.created, nowMs)}
                  </span>
                </div>
              </div>

              {/* Footer (AC35 / AC36): +N more running, only when N >= 2 */}
              {running.length >= 2 ? (
                <div className="mt-2 pt-2 border-t border-dashed border-[#E5E7EB] text-[11.5px] text-[#64748B]">
                  +{running.length - 1} more running
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
