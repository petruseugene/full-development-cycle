'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, Task, TaskStatus } from '@/lib/types';
import { STATUS_DOT } from './Sidebar';

type PaletteItem =
  | { kind: 'task'; task: Task; feature: Feature }
  | { kind: 'command'; id: 'new-feature'; label: string; kbd: string };

type PinItem = { kind: 'pin'; feature: Feature };

export function CommandPalette({
  open,
  onClose,
  features,
  onPickTask,
  onPickNewFeature,
  mode = 'search',
  pinnedSlugs = [],
  onPickFeatureToPin,
}: {
  open: boolean;
  onClose: () => void;
  features: Feature[];
  onPickTask: (task: Task, feature: Feature) => void;
  onPickNewFeature: () => void;
  mode?: 'search' | 'pin';
  pinnedSlugs?: string[];
  onPickFeatureToPin?: (feature: Feature) => void;
}) {
  const [query, setQuery] = useState('');
  const [focusedIdx, setFocusedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setFocusedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
    }
  }, [open]);

  // --- search-mode items ---------------------------------------------------
  const taskItems = useMemo(() => {
    const all: { task: Task; feature: Feature }[] = [];
    for (const f of features) for (const t of f.tasks) all.push({ task: t, feature: f });
    if (!query) return all.slice(0, 8);
    const q = query.toLowerCase();
    return all
      .filter(({ task, feature }) =>
        task.title.toLowerCase().includes(q) || feature.title.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [features, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = taskItems.map(({ task, feature }) => ({
      kind: 'task' as const,
      task,
      feature,
    }));
    list.push({
      kind: 'command',
      id: 'new-feature',
      label: 'New feature from prompt…',
      kbd: 'N',
    });
    return list;
  }, [taskItems]);

  // --- pin-mode items ------------------------------------------------------
  const pinnedSet = useMemo(() => new Set(pinnedSlugs), [pinnedSlugs]);
  const pinItems = useMemo<PinItem[]>(() => {
    const unpinned = features.filter((f) => !pinnedSet.has(f.slug));
    if (!query) return unpinned.map((feature) => ({ kind: 'pin' as const, feature }));
    const q = query.toLowerCase();
    return unpinned
      .filter(
        (f) => f.title.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q),
      )
      .map((feature) => ({ kind: 'pin' as const, feature }));
  }, [features, pinnedSet, query]);

  // navigable item count differs by mode
  const navLength = mode === 'pin' ? pinItems.length : items.length;

  useEffect(() => {
    setFocusedIdx(0);
  }, [query, mode]);

  const activate = (idx: number) => {
    if (mode === 'pin') {
      const item = pinItems[idx];
      if (!item) return;
      onPickFeatureToPin?.(item.feature);
      onClose();
      return;
    }
    const item = items[idx];
    if (!item) return;
    if (item.kind === 'task') {
      onPickTask(item.task, item.feature);
      onClose();
    } else if (item.kind === 'command' && item.id === 'new-feature') {
      onPickNewFeature();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIdx((i) => Math.min(i + 1, Math.max(0, navLength - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(focusedIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  if (mode === 'pin') {
    const availableCount = pinItems.length;
    const pinnedCount = pinnedSlugs.length;
    return (
      <div
        className="fixed inset-0 z-30 cmdk-bg flex items-start justify-center pt-[96px]"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="w-[640px] rounded-xl border border-line bg-white overflow-hidden flex flex-col"
          style={{ boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28), 0 6px 18px rgba(15, 23, 42, 0.12)' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="palette-pin-title"
        >
          {/* Title bar */}
          <header className="palette-titlebar">
            <span className="palette-title" id="palette-pin-title">Pin a feature</span>
            <span className="palette-mode-pill">PIN MODE</span>
            <span className="flex-1" />
            <span className="inline-flex items-center gap-1 mono text-[10.5px] text-ink-500">
              <span className="kbd">⌘</span>
              <span className="kbd">K</span>
              dismiss
            </span>
          </header>

          {/* Search row */}
          <div className="palette-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Filter features…"
              aria-label="Filter features to pin"
            />
            <span className="kbd">Esc</span>
          </div>

          {/* Body: list or empty state */}
          {availableCount === 0 ? (
            <div className="palette-empty" role="status">
              <span className="icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M12 17V4M12 4l4 4M12 4l-4 4" />
                  <path d="M5 20h14" />
                </svg>
              </span>
              <div className="head">All features are pinned</div>
              <div className="sub">Unpin one from the Sidebar to make space.</div>
            </div>
          ) : (
            <>
              <div className="palette-section-h">Features · not yet pinned</div>
              <ul
                className="palette-list"
                role="listbox"
                aria-label="Features available to pin"
              >
                {pinItems.map((item, i) => {
                  const f = item.feature;
                  const status: TaskStatus = f.derived.overallStatus;
                  const dot = STATUS_DOT[status];
                  const active = i === focusedIdx;
                  return (
                    <li
                      key={f.slug}
                      className={'cmdk-row pin-row' + (active ? ' active' : '')}
                      role="option"
                      aria-selected={active}
                      data-slug={f.slug}
                      onMouseEnter={() => setFocusedIdx(i)}
                      onClick={() => activate(i)}
                    >
                      <span className={`sd ${dot}`} aria-hidden="true" />
                      <span className="row-title">{f.title}</span>
                      <span className="slug-pill">{f.slug}</span>
                      <span className="row-hint">
                        <span className="kbd">↵</span> pin
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {/* Footer */}
          <footer className="palette-footer">
            {availableCount > 0 && (
              <>
                <span className="footer-hint">
                  <span className="kbd">↑</span>
                  <span className="kbd">↓</span>
                  navigate
                </span>
                <span className="footer-hint">
                  <span className="kbd">↵</span> pin feature
                </span>
              </>
            )}
            <span className="footer-hint">
              <span className="kbd">Esc</span> close
            </span>
            <span className="flex-1" />
            <span className="footer-hint">
              {availableCount === 0
                ? '0 features available'
                : `${availableCount} features available · ${pinnedCount} already pinned`}
            </span>
          </footer>
        </div>
      </div>
    );
  }

  // --- search mode (unchanged behaviour, AC14) -----------------------------
  return (
    <div
      className="fixed inset-0 z-50 cmdk-bg flex items-start justify-center pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[640px] rounded-xl border border-line bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-line">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth="1.8">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 outline-none text-[14px] text-ink-900 placeholder:text-ink-400"
            placeholder="Search or type a command…"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="p-2 max-h-[50vh] overflow-auto">
          <div className="px-2 py-1 mono text-[10.5px] uppercase tracking-wider text-ink-400">
            Tasks
          </div>
          {taskItems.length === 0 && (
            <div className="px-3 py-2 text-[12.5px] text-ink-500">No matching tasks.</div>
          )}
          {items.map((item, i) => {
            if (item.kind === 'task') {
              const { task, feature } = item;
              return (
                <div
                  key={`task:${feature.id}:${task.id}`}
                  className={'cmdk-row' + (i === focusedIdx ? ' active' : '')}
                  onMouseEnter={() => setFocusedIdx(i)}
                  onClick={() => activate(i)}
                >
                  <span className="mono text-[10.5px] text-ink-500 w-20 truncate">{feature.slug.slice(0, 18)}</span>
                  <span className="text-[13px] truncate">{task.title}</span>
                  <span className={`ml-auto chip ${task.tag}`}>{task.tag}</span>
                </div>
              );
            }
            return null;
          })}
          <div className="px-2 py-1 mono text-[10.5px] uppercase tracking-wider text-ink-400 mt-1">
            Commands
          </div>
          {items.map((item, i) => {
            if (item.kind === 'command') {
              return (
                <div
                  key={`cmd:${item.id}`}
                  className={'cmdk-row' + (i === focusedIdx ? ' active' : '')}
                  onMouseEnter={() => setFocusedIdx(i)}
                  onClick={() => activate(i)}
                >
                  <span className="kbd w-8 text-center">{item.kbd}</span>
                  <span className="text-[13px]">{item.label}</span>
                </div>
              );
            }
            return null;
          })}
        </div>
        <div className="px-3 py-2 border-t border-line flex items-center gap-2 mono text-[10.5px] text-ink-500">
          <span>↑ ↓ navigate · ↩ open</span>
          <span className="ml-auto">Dev Cycle · v0.1</span>
        </div>
      </div>
    </div>
  );
}
