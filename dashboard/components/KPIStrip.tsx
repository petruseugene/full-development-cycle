import type { KPIs } from '@/lib/types';

function sparklinePoints(values: number[], width = 80, height = 28): string {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1 || 1)) * width;
      const y = height - 4 - ((v - min) / span) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function formatHours(hours: number | null): string {
  if (hours == null) return '—';
  const whole = Math.floor(hours);
  const mins = Math.round((hours - whole) * 60);
  return `${whole}h·${mins.toString().padStart(2, '0')}m`;
}

export function KPIStrip({ kpis }: { kpis: KPIs }) {
  const cycleStr = formatHours(kpis.avgCycleHours);
  const [whole, rest] = cycleStr.split('·');
  return (
    <section className="px-6 py-4 grid grid-cols-5 gap-3 hair bg-white">
      <Card title="Active features" sub={`${kpis.activeFeatures} open`}>
        <Stat>{kpis.activeFeatures}</Stat>
        <svg viewBox="0 0 80 28" className="w-[80px] h-7">
          <polyline className="spark" stroke="#94A3B8" points={sparklinePoints(kpis.trends.activeFeatures)} />
        </svg>
      </Card>

      <Card
        title="Tasks in flight"
        sub={kpis.tasksInFlight === 0 ? 'idle' : `${kpis.tasksInFlight} running`}
        right={<span className="sd progress pulse-dot rounded-full" style={{ width: 8, height: 8 }} />}
      >
        <Stat>{kpis.tasksInFlight}</Stat>
        <BarTrend values={kpis.trends.activeFeatures} />
      </Card>

      <Card
        title="Blocked"
        sub={kpis.blocked === 0 ? 'all clear' : 'awaiting human review'}
        right={<span className="sd blocked rounded-full" style={{ width: 7, height: 7 }} />}
      >
        <div className={'text-[26px] leading-none font-semibold tracking-tight ' + (kpis.blocked > 0 ? 'text-red-600' : 'text-ink-900')}>
          {kpis.blocked}
        </div>
        <svg viewBox="0 0 80 28" className="w-[80px] h-7">
          <polyline className="spark" stroke="#DC2626" points={sparklinePoints(kpis.trends.blocked)} />
        </svg>
      </Card>

      <Card title="Avg cycle" sub="spec → merge">
        <div className="text-[26px] leading-none font-semibold text-ink-900 tracking-tight">
          {whole}
          {rest && <span className="text-ink-400 text-[16px] font-medium">·{rest}</span>}
        </div>
        <svg viewBox="0 0 80 28" className="w-[80px] h-7">
          <polyline className="spark" stroke="#059669" points={sparklinePoints(kpis.trends.cycleHours)} />
        </svg>
      </Card>

      <Card title="Agent spend" sub={`budget ${Math.round((kpis.agentSpend.dollars / kpis.agentSpend.budget) * 100)}% of $${kpis.agentSpend.budget}`}>
        <div className="text-[26px] leading-none font-semibold text-ink-900 tracking-tight">
          ${Math.floor(kpis.agentSpend.dollars)}.<span className="text-ink-400">{(kpis.agentSpend.dollars % 1).toFixed(2).slice(2)}</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="mono text-[10.5px] text-ink-500">{(kpis.agentSpend.tokens / 1_000_000).toFixed(1)}M tok</div>
          <div className="w-[72px] h-1 rounded-full bg-ink-100 overflow-hidden">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.min(100, (kpis.agentSpend.dollars / kpis.agentSpend.budget) * 100)}%` }}
            />
          </div>
        </div>
      </Card>
    </section>
  );
}

function Card({
  title,
  sub,
  right,
  children,
}: {
  title: string;
  sub: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-white p-3.5">
      <div className="flex items-center justify-between">
        <div className="text-[11.5px] uppercase tracking-wider mono text-ink-500">{title}</div>
        {right}
      </div>
      <div className="mt-2 flex items-end justify-between">{children}</div>
      <div className="mt-2 mono text-[11px] text-ink-500">{sub}</div>
    </div>
  );
}

function Stat({ children }: { children: React.ReactNode }) {
  return <div className="text-[26px] leading-none font-semibold text-ink-900 tracking-tight">{children}</div>;
}

function BarTrend({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex gap-0.5 items-end h-7">
      {values.slice(-5).map((v, i) => {
        const h = Math.max(2, (v / max) * 22);
        const shade = ['bg-ink-200', 'bg-ink-300', 'bg-blue-400', 'bg-blue-600', 'bg-blue-700'][i] ?? 'bg-blue-700';
        return <span key={i} className={`block w-1.5 ${shade} rounded-sm`} style={{ height: `${h}px` }} />;
      })}
    </div>
  );
}
