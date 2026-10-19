'use client';

import { useSnapshot } from '@/lib/snapshot-context';
import type { Feature } from '@/lib/types';

function latestTs(f: Feature): number {
  const hs = f.meta?.history ?? [];
  return hs.length ? Math.max(...hs.map((h) => Date.parse(h.ts))) : 0;
}

export default function ReleasesPage() {
  const { snapshot } = useSnapshot();
  if (snapshot == null) return null;

  const shipped = snapshot.features
    .filter((f) => f.meta?.current_phase === 'done')
    .slice()
    .sort((a, b) => latestTs(b) - latestTs(a));

  return (
    <main className="flex-1 min-w-0 px-6 py-4">
      <header className="flex items-baseline gap-2.5 mb-4">
        <h1 className="text-[13px] font-semibold text-ink-900">Releases</h1>
        <span className="text-[12px] text-ink-500">{shipped.length}</span>
      </header>

      {shipped.length === 0 ? (
        <p className="text-[12px] text-ink-500">No releases yet</p>
      ) : (
        <ol role="list" className="flex flex-col gap-1">
          {shipped.map((f) => {
            const ts = latestTs(f);
            const merged = ts ? new Date(ts).toLocaleString() : '—';
            const branch = f.meta?.branch;
            return (
              <li key={f.id} className="feat-row">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink-900 truncate">
                    {f.title}
                  </span>
                </div>
                <div className="mono text-[10px] text-ink-500 mt-0.5 ml-4">
                  {f.slug}
                </div>
                <div className="mono text-[10px] text-ink-500 mt-0.5 ml-4">
                  {merged}
                  {branch ? <span className="ml-2">{branch}</span> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
