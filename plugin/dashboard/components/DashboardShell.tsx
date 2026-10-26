'use client';

import { useMemo, useState } from 'react';
import type { DashboardSnapshot, Feature, Task } from '@/lib/types';
import { Sidebar } from '@/components/Sidebar';
import { KPIStrip } from '@/components/KPIStrip';
import { Toolbar, type OpenPopover } from '@/components/Toolbar';
import { Board } from '@/components/Board';
import { LiveTicker } from '@/components/LiveTicker';
import {
  applyFilters,
  EMPTY_FILTERS,
  type Filters,
  type GroupKey,
  type SortKey,
} from '@/lib/board-filters';

export function DashboardShell({
  snapshot,
  activeId,
  onSelectFeature,
  onSelectAll,
  onOpenTask,
}: {
  snapshot: DashboardSnapshot | null;
  activeId: string | null;
  onSelectFeature: (id: string) => void;
  onSelectAll: () => void;
  onOpenTask: (task: Task, feature: Feature) => void;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [groupKey, setGroupKey] = useState<GroupKey>('status');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);

  const features = snapshot?.features ?? [];
  const visibleFeatures = activeId
    ? features.filter((f) => f.id === activeId).concat(features.filter((f) => f.id !== activeId))
    : features;
  const sidebarFeatures = visibleFeatures;
  const baseBoardFeatures = useMemo(() => {
    const scoped = activeId ? features.filter((f) => f.id === activeId) : features;
    return scoped.length ? scoped : features;
  }, [features, activeId]);

  const boardFeatures = useMemo(
    () => applyFilters(baseBoardFeatures, filters),
    [baseBoardFeatures, filters],
  );

  return (
    <div className="flex">
      <Sidebar
        features={sidebarFeatures}
        activeId={activeId}
        onSelect={onSelectFeature}
        onSelectAll={onSelectAll}
      />
      <main className="flex-1 min-w-0">
        {snapshot && <KPIStrip kpis={snapshot.kpis} />}
        <Toolbar
          syncedAt={snapshot?.generatedAt ?? null}
          filters={filters}
          onFiltersChange={setFilters}
          features={baseBoardFeatures}
          groupKey={groupKey}
          onGroupKeyChange={setGroupKey}
          sortKey={sortKey}
          onSortKeyChange={setSortKey}
          openPopover={openPopover}
          onOpenPopoverChange={setOpenPopover}
        />
        <Board
          features={boardFeatures}
          groupKey={groupKey}
          sortKey={sortKey}
          onOpenTask={onOpenTask}
        />
        <LiveTicker events={snapshot?.ticker ?? []} />
      </main>
    </div>
  );
}
