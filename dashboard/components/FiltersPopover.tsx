'use client';

import { useEffect, useRef } from 'react';
import type { Feature, TaskStatus, TaskTag } from '@/lib/types';
import {
  EMPTY_FILTERS,
  activeFilterCount,
  type Filters,
} from '@/lib/board-filters';

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'TODO', label: 'To do' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'IN_TESTING', label: 'Testing' },
  { value: 'BLOCKED', label: 'Blocked' },
  { value: 'DONE', label: 'Merged' },
];

const TAG_OPTIONS: { value: TaskTag; label: string }[] = [
  { value: 'frontend', label: 'Frontend' },
  { value: 'backend', label: 'Backend' },
  { value: 'mixed', label: 'Mixed' },
  { value: 'infra', label: 'Infra' },
];

const FLAG_OPTIONS: { value: 'owner' | 'content'; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'content', label: 'Content' },
];

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

export function FiltersPopover({
  filters,
  onFiltersChange,
  features,
  onClose,
}: {
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  features: Feature[];
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstCheckboxRef = useRef<HTMLInputElement | null>(null);

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

  // Focus the first checkbox on open.
  useEffect(() => {
    firstCheckboxRef.current?.focus();
  }, []);

  const count = activeFilterCount(filters);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Filters"
      className="absolute top-full mt-1 left-0 z-20 w-64 rounded-md border border-line bg-white shadow-lg p-3 text-[12.5px] text-ink-800"
    >
      <Section title="Status">
        {STATUS_OPTIONS.map((opt, i) => (
          <CheckboxRow
            key={opt.value}
            label={opt.label}
            checked={filters.statuses.includes(opt.value)}
            inputRef={i === 0 ? firstCheckboxRef : undefined}
            onChange={() =>
              onFiltersChange({
                ...filters,
                statuses: toggle(filters.statuses, opt.value),
              })
            }
          />
        ))}
      </Section>

      <Section title="Tag">
        {TAG_OPTIONS.map((opt) => (
          <CheckboxRow
            key={opt.value}
            label={opt.label}
            checked={filters.tags.includes(opt.value)}
            onChange={() =>
              onFiltersChange({
                ...filters,
                tags: toggle(filters.tags, opt.value),
              })
            }
          />
        ))}
      </Section>

      <Section title="Type">
        {FLAG_OPTIONS.map((opt) => (
          <CheckboxRow
            key={opt.value}
            label={opt.label}
            checked={filters.flags.includes(opt.value)}
            onChange={() =>
              onFiltersChange({
                ...filters,
                flags: toggle(filters.flags, opt.value),
              })
            }
          />
        ))}
      </Section>

      <Section title="Feature">
        {features.length === 0 ? (
          <div className="px-1 py-1 text-ink-500">No features</div>
        ) : (
          features.map((feature) => (
            <CheckboxRow
              key={feature.id}
              label={feature.title}
              checked={filters.featureIds.includes(feature.id)}
              onChange={() =>
                onFiltersChange({
                  ...filters,
                  featureIds: toggle(filters.featureIds, feature.id),
                })
              }
            />
          ))
        )}
      </Section>

      {count > 0 && (
        <div className="mt-2 pt-2 border-t border-line flex justify-end">
          <button
            type="button"
            className="text-[12px] text-ink-500 hover:text-ink-800"
            onClick={() => onFiltersChange(EMPTY_FILTERS)}
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
  inputRef,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className="flex items-center gap-2 px-1 py-1 rounded-sm cursor-pointer hover:bg-canvas">
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5"
      />
      <span className="truncate">{label}</span>
    </label>
  );
}
