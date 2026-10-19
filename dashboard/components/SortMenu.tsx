'use client';

import { useEffect, useRef } from 'react';
import { SORT_KEY_LABELS, type SortKey } from '@/lib/board-filters';

const SORT_OPTIONS: SortKey[] = ['recent', 'title', 'status'];

export function SortMenu({
  sortKey,
  onSortKeyChange,
  onClose,
}: {
  sortKey: SortKey;
  onSortKeyChange: (k: SortKey) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstRadioRef = useRef<HTMLInputElement | null>(null);

  // Dismiss on outside-click or Escape.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Focus the first radio on open.
  useEffect(() => {
    firstRadioRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="menu"
      aria-label="Sort"
      // Left-aligned to the button's left edge to match Filters and Group
      // (AC4.3). max-w + overflow-hidden keep the popover from forcing
      // horizontal scroll on narrow viewports; the 3 radio rows are short
      // enough that clipping is not visible in practice.
      className="absolute top-full mt-1 left-0 z-20 w-44 max-w-[280px] overflow-hidden rounded-md border border-line bg-white shadow-lg p-3 text-[12.5px] text-ink-800"
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
        Sort by
      </div>
      <div className="flex flex-col gap-0.5">
        {SORT_OPTIONS.map((opt, i) => (
          <label
            key={opt}
            className="flex items-center gap-2 px-1 py-1 rounded-sm cursor-pointer hover:bg-canvas"
          >
            <input
              ref={i === 0 ? firstRadioRef : undefined}
              type="radio"
              name="sort-key"
              checked={sortKey === opt}
              onChange={() => {
                onSortKeyChange(opt);
                onClose();
              }}
              className="h-3.5 w-3.5"
            />
            <span className="truncate">{SORT_KEY_LABELS[opt]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
