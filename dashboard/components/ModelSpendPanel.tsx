'use client';

import { useMemo } from 'react';
import { formatTime, formatTokens } from '@/lib/format';
import type { Feature } from '@/lib/types';
import { aggregateByModel } from '@/lib/model-spend';

export function ModelSpendPanel({ feature }: { feature: Feature }) {
  const history = feature.meta?.history;
  const rows = useMemo(() => aggregateByModel(history), [history]);
  const total = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      tokens_k: acc.tokens_k + r.tokens_k,
      time_s: acc.time_s + r.time_s,
    }),
    { calls: 0, tokens_k: 0, time_s: 0 },
  );
  const headingId = `model-spend-${feature.id}`;
  const numCls = 'px-2 py-1.5 text-right mono text-ink-700';

  return (
    <section
      aria-labelledby={headingId}
      className="mx-6 mb-3 min-w-0 rounded-md border border-line bg-white px-3 py-2"
    >
      <h2 id={headingId} className="text-[13px] font-semibold text-ink-900 mb-1.5">
        Spend by model
      </h2>
      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-500">No dispatches recorded yet.</p>
      ) : (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Spend by model table">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-500">
                <th scope="col" className="px-2 py-1 font-medium">Model</th>
                <th scope="col" className="px-2 py-1 font-medium text-right">Calls</th>
                <th scope="col" className="px-2 py-1 font-medium text-right">Tokens</th>
                <th scope="col" className="px-2 py-1 font-medium text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="border-t border-line">
                  <td className="px-2 py-1.5 mono text-ink-900">{r.model}</td>
                  <td className={numCls}>{r.calls}</td>
                  <td className={numCls}>{formatTokens(r.tokens_k)}</td>
                  <td className={numCls}>{formatTime(r.time_s)}</td>
                </tr>
              ))}
              <tr className="border-t border-line font-semibold">
                <td className="px-2 py-1.5 text-ink-900">Total</td>
                <td className="px-2 py-1.5 text-right mono text-ink-900">{total.calls}</td>
                <td className="px-2 py-1.5 text-right mono text-ink-900">{formatTokens(total.tokens_k)}</td>
                <td className="px-2 py-1.5 text-right mono text-ink-900">{formatTime(total.time_s)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
