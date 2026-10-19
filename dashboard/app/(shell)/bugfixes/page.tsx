'use client';

import { useSnapshot } from '@/lib/snapshot-context';
import { STATUS_DOT } from '@/components/Sidebar';

export default function BugfixesPage() {
  const { snapshot } = useSnapshot();
  if (snapshot == null) return null;

  const rows = snapshot.features.filter((f) => f.meta?.flow === 'bugfix');

  return (
    <main className="flex-1 min-w-0 px-6 py-4">
      <header className="flex items-baseline gap-2.5 mb-4">
        <h1 className="text-[13px] font-semibold text-ink-900">Bugfixes</h1>
        <span className="text-[12px] text-ink-500">{rows.length}</span>
      </header>

      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-500">No bugfixes yet</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((f) => {
            const phase = f.meta?.current_phase;
            const dotClass = STATUS_DOT[f.derived.overallStatus];
            return (
              <div key={f.id} className="feat-row">
                <div className="flex items-center gap-2">
                  <span className={'sd ' + dotClass} />
                  <span className="text-[13px] font-medium text-ink-900 truncate">
                    {f.title}
                  </span>
                  {phase && <span className="chip">{phase}</span>}
                </div>
                <div className="mono text-[10px] text-ink-500 mt-0.5 ml-4">
                  {f.slug}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
