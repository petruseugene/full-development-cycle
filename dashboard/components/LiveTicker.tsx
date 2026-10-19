import type { HistoryEvent } from '@/lib/types';
import { agentInfo } from './AgentBadge';

export function LiveTicker({ events }: { events: HistoryEvent[] }) {
  return (
    <section className="border-t border-line bg-white px-6 py-3 sticky bottom-0">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 mono text-[11px] text-ink-500 shrink-0">
          <span className="sd progress pulse-dot rounded-full" style={{ width: 6, height: 6 }} /> LIVE
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="flex items-center gap-5 mono text-[11.5px] text-ink-700 whitespace-nowrap">
            {events.length === 0 && (
              <span className="text-ink-500">Waiting for agent activity…</span>
            )}
            {events.map((ev, i) => {
              const info = agentInfo(ev.subagent as Parameters<typeof agentInfo>[0]);
              return (
                <span key={i} className="flex items-center gap-2">
                  <span
                    className="mono-tile inline-flex"
                    style={{ background: info.color }}
                  >
                    {info.mono}
                  </span>
                  <span className="text-ink-500">→</span>
                  <span>
                    {ev.status} <span className="text-ink-900">{ev.phase}</span>
                  </span>
                  <span className="text-ink-400">· {formatAgo(ev.ts)}</span>
                  {i < events.length - 1 && <span className="text-ink-300 ml-2">|</span>}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function formatAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(d) || d < 0) return iso;
  if (d < 60) return `${Math.max(1, Math.round(d))}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  return `${Math.round(d / 3600)}h ago`;
}
