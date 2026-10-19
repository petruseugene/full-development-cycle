'use client';

import type { Feature, Task, TaskStatus } from '@/lib/types';
import { AgentBadge } from './AgentBadge';

const ACCENT: Record<TaskStatus, string> = {
  TODO: 'accent-todo',
  IN_PROGRESS: 'accent-progress',
  IN_TESTING: 'accent-testing',
  BLOCKED: 'accent-blocked',
  DONE: 'accent-done',
};

const STEPS_DONE: Record<TaskStatus, ('done' | 'cur' | 'fail' | '')[]> = {
  TODO: ['', '', '', '', ''],
  IN_PROGRESS: ['done', 'cur', '', '', ''],
  IN_TESTING: ['done', 'done', 'done', 'cur', ''],
  BLOCKED: ['done', 'done', 'done', 'fail', ''],
  DONE: ['done', 'done', 'done', 'done', 'done'],
};

export function TaskCard({
  task,
  feature,
  onOpen,
  showStatusChip = false,
}: {
  task: Task;
  feature: Feature;
  onOpen: () => void;
  showStatusChip?: boolean;
}) {
  const accent = ACCENT[task.status];
  const steps = STEPS_DONE[task.status];
  const blocked = task.status === 'BLOCKED';

  return (
    <article
      className={`card ${accent} p-3.5 rounded-lg cursor-pointer`}
      onClick={onOpen}
      style={blocked ? { background: 'linear-gradient(0deg, rgba(254,226,226,.35), rgba(254,226,226,0) 80%)' } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="mono text-[10.5px] text-ink-500">{feature.slug.split('-').slice(-1)[0].toUpperCase()}-{task.index.toString().padStart(3, '0')}</span>
        <div className="flex items-center gap-1.5">
          {showStatusChip && <MiniStatusChip status={task.status} />}
          {!task.stackless && <span className={`chip ${task.tag}`}>{task.tag}</span>}
          {task.owner && <span className="chip owner">Owner</span>}
          {task.content && <span className="chip content">Content</span>}
        </div>
      </div>
      <h4 className="text-[14px] font-semibold text-ink-900 mt-1.5 leading-snug">{task.title}</h4>
      {task.description && (
        <p className="text-[12.5px] text-ink-500 mt-1 leading-relaxed line-clamp-2">{task.description}</p>
      )}
      <div className="step-bar mt-3">
        {steps.map((s, i) => (
          <span key={i} className={s} />
        ))}
      </div>

      {task.status === 'IN_PROGRESS' && task.activeAgents?.length ? (
        <div className="mt-2.5 rounded-md bg-ink-50 border border-line p-2 mono text-[11px] text-ink-700 leading-snug shimmer-track">
          <span className="text-ink-400">{task.activeAgents[0].slice(0, 2).toUpperCase()} →</span>{' '}
          {task.acceptance ? task.acceptance.split(/\.|\n/)[0].slice(0, 80) : 'in progress…'}
        </div>
      ) : null}

      {blocked && task.blockerReason ? (
        <div className="mt-2.5 rounded-md border border-red-200 bg-red-50 p-2 mono text-[11px] text-red-700 leading-snug">
          <span className="font-semibold">BLOCKED</span> — {task.blockerReason}
        </div>
      ) : null}

      {task.status === 'IN_TESTING' && (
        <div className="mt-2.5 rounded-md border border-line p-2 mono text-[11px] text-ink-700">
          <div className="flex items-center justify-between">
            <span className="text-ink-500">tests</span>
            <span className="text-amber-600">running…</span>
          </div>
        </div>
      )}

      {task.status === 'DONE' && (
        <div className="mt-2.5 flex items-center gap-2 mono text-[10.5px] text-ink-500">
          <span className="text-emerald-700">✓ merged</span>
        </div>
      )}

      <div className="flex items-center justify-between mt-2.5">
        <div className="flex items-center gap-1.5">
          {(task.activeAgents ?? feature.derived.activeAgents.slice(0, 2)).slice(0, 3).map((a) => (
            <AgentBadge key={a} name={a} />
          ))}
        </div>
        <div className="flex items-center gap-2 mono text-[10.5px] text-ink-500">
          {task.reviewCycles ? (
            <span className="text-purple-700">fix {task.reviewCycles}/3</span>
          ) : null}
          {task.status === 'IN_PROGRESS' && (
            <span className="flex items-center gap-1 text-blue-700">
              <span className="sd progress pulse-dot rounded-full" style={{ width: 7, height: 7 }} />
              running
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

const STATUS_CHIP: Record<TaskStatus, { bg: string; bd: string; fg: string; dot: string; label: string }> = {
  TODO: { bg: '#F4F6FA', bd: '#E5E7EB', fg: '#475569', dot: 'todo', label: 'to do' },
  IN_PROGRESS: { bg: '#EFF6FF', bd: '#DBEAFE', fg: '#1D4ED8', dot: 'progress', label: 'in progress' },
  IN_TESTING: { bg: '#FFF7ED', bd: '#FFE4C7', fg: '#B45309', dot: 'testing', label: 'testing' },
  BLOCKED: { bg: '#FEF2F2', bd: '#FECACA', fg: '#B91C1C', dot: 'blocked', label: 'blocked' },
  DONE: { bg: '#ECFDF5', bd: '#D1FAE5', fg: '#047857', dot: 'done', label: 'done' },
};

function MiniStatusChip({ status }: { status: TaskStatus }) {
  const s = STATUS_CHIP[status];
  return (
    <span
      className="chip"
      style={{ ['--ch-bg' as string]: s.bg, ['--ch-bd' as string]: s.bd, ['--ch-fg' as string]: s.fg }}
    >
      <span className={`sd ${s.dot}`} /> {s.label}
    </span>
  );
}
