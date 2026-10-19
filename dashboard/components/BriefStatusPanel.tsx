import type { Feature } from '@/lib/types';

export function BriefStatusPanel({ feature }: { feature: Feature }) {
  const history = feature.meta?.history;
  const n = Array.isArray(history) ? history.length : 0;
  const headingId = `brief-${feature.id}`;

  return (
    <section
      aria-labelledby={headingId}
      className="mx-6 mb-3 min-w-0 rounded-md border border-line bg-white px-3 py-2"
    >
      <h2 id={headingId} className="text-[13px] font-semibold text-ink-900 mb-1.5">
        Brief
      </h2>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mono text-[12px] text-ink-700">
        <span>Track: {feature.meta?.track ?? 'full'}</span>
        <span>Spec: {feature.specStatus ?? 'none'}</span>
        <span>History: {n} events</span>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-500">
        No task list (plan.md or spec.md ## Tasks)
      </p>
    </section>
  );
}
