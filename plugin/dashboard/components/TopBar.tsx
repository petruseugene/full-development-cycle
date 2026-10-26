'use client';

import OrchestratorPill from './OrchestratorPill';
import PendingApprovalsPill from './PendingApprovalsPill';
import { useSnapshot } from '@/lib/snapshot-context';

export function TopBar({
  onSearch,
  onNew,
  projectLabel = '',
}: {
  onSearch: () => void;
  onNew: () => void;
  projectLabel?: string;
}) {
  const { agentEnabled } = useSnapshot();
  return (
    <header className="h-12 flex items-center px-4 hair bg-white sticky top-0 z-30">
      <div className="flex items-center gap-2.5 w-[232px] pr-2">
        <div className="w-6 h-6 rounded-[7px] bg-primary text-white grid place-items-center mono text-[11px] font-semibold">
          DC
        </div>
        <div className="leading-tight min-w-0">
          <div className="text-[13px] font-semibold text-ink-900">Dev Cycle</div>
          <div className="mono text-[10px] text-ink-500 truncate" title={projectLabel}>
            {projectLabel}
          </div>
        </div>
      </div>

      <button
        onClick={onSearch}
        className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-line bg-canvas hover:bg-ink-50 w-[420px] text-left"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth="1.8">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="text-[13px] text-ink-500">Search features, tasks, agents…</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="kbd">⌘</span>
          <span className="kbd">K</span>
        </span>
      </button>

      <div className="flex-1" />

      <div className="flex items-center gap-2">
        <OrchestratorPill />
        {agentEnabled ? <PendingApprovalsPill /> : null}
        <button
          onClick={onNew}
          className="h-8 px-3 rounded-md bg-primary text-white text-[13px] font-medium flex items-center gap-2"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New feature
          <span
            className="kbd"
            style={{ background: 'rgba(255,255,255,.08)', color: '#CBD5E1', borderColor: 'rgba(255,255,255,.16)' }}
          >
            N
          </span>
        </button>
      </div>
    </header>
  );
}
