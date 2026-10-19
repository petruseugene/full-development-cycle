'use client';

import type { Feature, Task } from '@/lib/types';
import {
  bucketBoard,
  sortColumnItems,
  type GroupKey,
  type SortKey,
} from '@/lib/board-filters';
import { TaskCard } from './TaskCard';
import { useSnapshot } from '@/lib/snapshot-context';

export function Board({
  features,
  groupKey,
  sortKey,
  onOpenTask,
  onAddTask,
}: {
  features: Feature[];
  groupKey: GroupKey;
  sortKey: SortKey;
  onOpenTask: (task: Task, feature: Feature) => void;
  // Parent owns the QuickAddTaskModal; Board fires this for the column-header
  // `+ Task` trigger (only rendered when grouping by feature). Trigger element
  // is passed so the parent can return focus on close.
  onAddTask?: (featureId: string, trigger: HTMLButtonElement | null) => void;
}) {
  // Chat drawer trigger (Task 10 step 4 / R22(a)). Rendered once per feature
  // on the feature-group column header (next to slug-pill / phase chip /
  // + Task button), not per task card. When grouping by status/tag/agent the
  // Board has no per-feature header — the chat is still reachable via the
  // Sidebar pinned-feature click (R22b) and deep-link (R22c).
  const { openChat, agentEnabled } = useSnapshot();
  const columns = bucketBoard(features, groupKey).map((col) => ({
    ...col,
    items: sortColumnItems(col.items, sortKey),
  }));
  const showStatusChip = groupKey !== 'status';

  // Lookup feature by column key (only meaningful when groupKey === 'feature').
  const featureById = new Map(features.map((f) => [f.id, f]));

  // EmptyState renders only when every column is empty across the chosen grouping
  // (or no columns at all — e.g. tag/agent grouping with no in-scope tasks).
  const totalItems = columns.reduce((n, c) => n + c.items.length, 0);
  if (totalItems === 0) return <EmptyState />;

  // status → 5-col grid; feature → vertical stack, one feature per row;
  // tag/agent → grid with as many columns as buckets.
  const gridClass =
    groupKey === 'status'
      ? 'grid grid-cols-5 gap-4'
      : groupKey === 'feature'
        ? 'flex flex-col gap-6'
        : 'grid gap-4';
  const gridStyle =
    groupKey === 'status' || groupKey === 'feature'
      ? undefined
      : {
          gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))`,
        };

  return (
    <section className="px-6 pb-8 pt-1">
      <div className={gridClass} style={gridStyle}>
        {columns.map((col) => {
          // For feature grouping, look up the underlying Feature record so we can
          // render slug-pill, phase chip, and wire the + Task button trigger.
          // The synthetic 'other' bucket has no single feature → no button.
          const colFeature =
            groupKey === 'feature' && col.key !== 'other'
              ? featureById.get(col.key) ?? null
              : null;
          const currentPhase = colFeature?.meta?.current_phase ?? null;

          return (
            <div
              key={col.key}
              className="flex flex-col gap-3 col-scroll"
              style={
                groupKey === 'feature'
                  ? undefined
                  : { maxHeight: 'calc(100vh - 248px)', overflow: 'auto' }
              }
            >
              <div className="flex items-center sticky top-0 bg-canvas pt-1 pb-2 z-10">
                <div className="flex items-center gap-2 w-full">
                  {col.dot ? (
                    col.pulse && col.items.length > 0 ? (
                      <span
                        className={`sd ${col.dot} pulse-dot rounded-full`}
                        style={{ width: 7, height: 7 }}
                      />
                    ) : (
                      <span className={`sd ${col.dot}`} />
                    )
                  ) : null}
                  <h3 className="text-[13px] font-semibold text-ink-800">{col.label}</h3>
                  <span className="col-pill">{col.items.length}</span>
                  {colFeature ? (
                    <>
                      <span className="slug-pill mono">{colFeature.slug}</span>
                      {currentPhase ? (
                        <span className={`chip phase-${currentPhase}`}>{currentPhase}</span>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Add task to ${colFeature.title}`}
                        onClick={(e) => onAddTask?.(colFeature.id, e.currentTarget)}
                        className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded-md border border-line bg-white text-ink-700 text-[12px] font-medium hover:bg-ink-50 hover:text-ink-900 focus-visible:[outline:2px_solid_var(--primary)] focus-visible:outline-offset-1"
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          aria-hidden="true"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>Task</span>
                      </button>
                      {/* Chat button — opens the chat drawer for this
                          feature (R22(a)). Lives in the feature-group
                          header alongside slug-pill / phase chip / + Task
                          so it is rendered once per feature, not per task
                          card. */}
                      {agentEnabled ? (
                      <button
                        type="button"
                        aria-label={`Open chat for ${colFeature.title}`}
                        onClick={() => openChat(colFeature.id)}
                        className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-line bg-white text-ink-700 text-[12px] font-medium hover:bg-ink-50 hover:text-ink-900 focus-visible:[outline:2px_solid_var(--primary)] focus-visible:outline-offset-1"
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden="true"
                        >
                          <path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12Z" />
                        </svg>
                        <span>Chat</span>
                      </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>

              {col.items.map(({ task, feature }) => (
                <TaskCard
                  key={`${feature.id}:${task.id}`}
                  task={task}
                  feature={feature}
                  showStatusChip={showStatusChip}
                  onOpen={() => onOpenTask(task, feature)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="px-6 py-20 text-center">
      <div className="mx-auto max-w-md rounded-lg border border-line bg-white p-8">
        <div className="text-[14px] font-semibold text-ink-900">No tasks yet</div>
        <p className="text-[12.5px] text-ink-500 mt-2">No task list (plan.md or spec.md ## Tasks)</p>
        <p className="text-[12.5px] text-ink-500 mt-2 leading-relaxed">
          The dashboard is reading <span className="mono">docs/features/&lt;slug&gt;/</span> from disk. Once the
          orchestrator (or you) writes a <span className="mono">plan.md</span> with task lines like{' '}
          <span className="mono">- [TODO] **Task 1** (frontend): ...</span>, they will appear here.
        </p>
        <p className="text-[12.5px] text-ink-500 mt-3 leading-relaxed">
          To preview with sample data, run with <span className="mono">DASHBOARD_DEMO=1</span>.
        </p>
      </div>
    </section>
  );
}
