'use client';

import type React from 'react';
import type { Feature } from '@/lib/types';
import {
  activeFilterCount,
  GROUP_KEY_LABELS,
  SORT_KEY_LABELS,
  type Filters,
  type GroupKey,
  type SortKey,
} from '@/lib/board-filters';
import { FiltersPopover } from './FiltersPopover';
import { GroupMenu } from './GroupMenu';
import { SortMenu } from './SortMenu';

export type OpenPopover = 'filters' | 'group' | 'sort' | null;

export function Toolbar({
  syncedAt,
  filters,
  onFiltersChange,
  features,
  groupKey,
  onGroupKeyChange,
  sortKey,
  onSortKeyChange,
  openPopover,
  onOpenPopoverChange,
  selectedFeature,
  onAddTaskClick,
}: {
  syncedAt: string | null;
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  features: Feature[];
  groupKey: GroupKey;
  onGroupKeyChange: (k: GroupKey) => void;
  sortKey: SortKey;
  onSortKeyChange: (k: SortKey) => void;
  openPopover: OpenPopover;
  onOpenPopoverChange: (p: OpenPopover) => void;
  selectedFeature?: { id: string; title: string } | null;
  onAddTaskClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const ago = syncedAt ? relativeAgo(syncedAt) : '—';
  const count = activeFilterCount(filters);
  const filtersOpen = openPopover === 'filters';
  const groupOpen = openPopover === 'group';
  const sortOpen = openPopover === 'sort';

  return (
    <section className="px-6 py-3 flex items-center gap-2 bg-canvas">
      <div className="relative">
        <button
          type="button"
          className="selpill"
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          onClick={() => onOpenPopoverChange(filtersOpen ? null : 'filters')}
        >
          {count > 0 ? `Filters (${count})` : 'Filters'}
          <span aria-hidden className="text-ink-500">▾</span>
        </button>
        {filtersOpen && (
          <FiltersPopover
            filters={filters}
            onFiltersChange={onFiltersChange}
            features={features}
            onClose={() => onOpenPopoverChange(null)}
          />
        )}
      </div>
      <div className="relative">
        <button
          type="button"
          className="selpill"
          aria-haspopup="menu"
          aria-expanded={groupOpen}
          onClick={() => onOpenPopoverChange(groupOpen ? null : 'group')}
        >
          {`Group: ${GROUP_KEY_LABELS[groupKey]}`}
          <span aria-hidden className="text-ink-500">▾</span>
        </button>
        {groupOpen && (
          <GroupMenu
            groupKey={groupKey}
            onGroupKeyChange={onGroupKeyChange}
            onClose={() => onOpenPopoverChange(null)}
          />
        )}
      </div>
      <div className="relative">
        <button
          type="button"
          className="selpill"
          aria-haspopup="menu"
          aria-expanded={sortOpen}
          onClick={() => onOpenPopoverChange(sortOpen ? null : 'sort')}
        >
          {`Sort: ${SORT_KEY_LABELS[sortKey]}`}
          <span aria-hidden className="text-ink-500">▾</span>
        </button>
        {sortOpen && (
          <SortMenu
            sortKey={sortKey}
            onSortKeyChange={onSortKeyChange}
            onClose={() => onOpenPopoverChange(null)}
          />
        )}
      </div>
      {selectedFeature && onAddTaskClick ? (
        <button
          type="button"
          aria-label={`Add task to ${selectedFeature.title}`}
          onClick={onAddTaskClick}
          className="h-8 px-3 rounded-md bg-primary text-white text-[13px] font-medium inline-flex items-center gap-1 hover:opacity-90 focus-visible:[outline:2px_solid_var(--primary)] focus-visible:outline-offset-1"
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
      ) : null}
      <div className="flex-1" />
      <span className="mono text-[11px] text-ink-500">last sync {ago}</span>
    </section>
  );
}

function relativeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(1, Math.round(d))}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  return `${Math.round(d / 3600)}h ago`;
}
