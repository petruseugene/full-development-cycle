'use client';

import { useMemo } from 'react';
import { useSnapshot } from '@/lib/snapshot-context';
import { AgentBadge } from '@/components/AgentBadge';
import { formatTime, formatTokens } from '@/lib/format';
import type { AgentName, AgentRow } from '@/lib/types';

// Sort comparator per plan/AC6/AC25:
//   calls > 0 group: desc by calls, ties asc by name.
//   calls === 0 group: asc by name, placed at the bottom.
function sortAgents(rows: AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => {
    const aActive = a.calls > 0;
    const bActive = b.calls > 0;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive) {
      if (b.calls !== a.calls) return b.calls - a.calls;
    }
    return a.name.localeCompare(b.name);
  });
}

export default function AgentsPage() {
  const { snapshot } = useSnapshot();

  const agents = snapshot?.agents ?? [];
  const sorted = useMemo(() => sortAgents(agents), [agents]);
  const total = sorted.length;
  const active = useMemo(() => sorted.filter((a) => a.calls > 0).length, [sorted]);

  if (snapshot == null) return null;

  return (
    <main className="flex-1 min-w-0 px-6 py-4">
      <header className="flex items-baseline gap-2.5 mb-4">
        <h1 className="text-[13px] font-semibold text-ink-900">Agents</h1>
        <span className="text-[12px] text-ink-500">
          {total} agents · {active} active
        </span>
      </header>

      {active === 0 && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 px-3 py-2 rounded-md border border-line bg-amber-50 text-[12px] text-ink-700 flex items-start gap-2"
        >
          <span aria-hidden="true" className="font-semibold">!</span>
          <div>
            <div className="font-semibold text-ink-900">No features have run yet</div>
            <div className="text-ink-500">
              The catalog still lists every agent the playbook defines. Counters appear once a feature finishes its first phase.
            </div>
          </div>
        </div>
      )}

      <table className="w-full text-[12px]" aria-label="Agents catalog">
        <thead>
          <tr className="text-left text-ink-500">
            <th scope="col" className="px-2 py-1 font-medium" style={{ width: 56 }}></th>
            <th scope="col" className="px-2 py-1 font-medium">Agent</th>
            <th scope="col" className="px-2 py-1 font-medium text-right" style={{ width: 80 }}>Calls</th>
            <th scope="col" className="px-2 py-1 font-medium text-right" style={{ width: 100 }}>Approved</th>
            <th scope="col" className="px-2 py-1 font-medium text-right" style={{ width: 80 }}>Retried</th>
            <th scope="col" className="px-2 py-1 font-medium text-right" style={{ width: 90 }}>Time</th>
            <th scope="col" className="px-2 py-1 font-medium text-right" style={{ width: 90 }}>Tokens</th>
            <th scope="col" className="px-2 py-1 font-medium" style={{ width: 240 }}>Last used</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const isZero = row.calls === 0;
            const numCls =
              'px-2 py-2 text-right mono ' + (isZero ? 'text-ink-400' : 'text-ink-700');
            return (
              <tr key={row.name} className="feat-row">
                <td className="px-2 py-2">
                  <AgentBadge name={row.name as AgentName} size="lg" />
                </td>
                <td className="px-2 py-2 min-w-0">
                  <div className="font-semibold text-ink-900 truncate">{row.name}</div>
                  <div className="text-ink-500 truncate" style={{ maxWidth: 360 }}>
                    {row.description}
                  </div>
                </td>
                <td className={numCls}>{row.calls}</td>
                <td className={numCls}>
                  {row.approved == null ? (
                    <span className="text-ink-400">—</span>
                  ) : (
                    row.approved
                  )}
                </td>
                <td className={numCls}>{row.retried}</td>
                <td className={numCls}>{formatTime(row.time_s)}</td>
                <td className={numCls}>{formatTokens(row.tokens_k)}</td>
                <td className="px-2 py-2">
                  {row.last_used == null ? (
                    <span className="text-ink-400">—</span>
                  ) : (
                    <span className="slug-pill">{row.last_used}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
