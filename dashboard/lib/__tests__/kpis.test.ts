import { describe, it, expect } from 'vitest';
import { buildKPIs, closeTasksOfClosedFeature, featureTokensK } from '../kpis';
import { spendBudgetLine } from '../kpi-format';
import { applyFilters, featuresInScope, isCollapsedColumn, bucketBoard, EMPTY_FILTERS } from '../board-filters';
import { aggregateByModel } from '../model-spend';
import type { Feature, Task } from '../types';

const task = (id: string, status: Task['status']): Task =>
  ({ id, index: 1, title: id, tag: 'backend', owner: false, content: false, status }) as Task;

function feat(id: string, phase: string, tasks: Task[], extra: Record<string, unknown> = {}): Feature {
  return {
    id,
    slug: id,
    tasks,
    derived: { overallStatus: phase === 'done' ? 'DONE' : 'IN_PROGRESS' },
    meta: { current_phase: phase, history: [], ...extra },
  } as unknown as Feature;
}

describe('closed features', () => {
  it('closeTasksOfClosedFeature turns stale statuses into DONE only when current_phase is done', () => {
    const ts = [task('a', 'IN_TESTING'), task('b', 'IN_PROGRESS')];
    const meta = { current_phase: 'done' } as Feature['meta'];
    expect(closeTasksOfClosedFeature(ts, meta).map((t) => t.status)).toEqual(['DONE', 'DONE']);
    expect(closeTasksOfClosedFeature(ts, { current_phase: 'implement' } as Feature['meta'])).toBe(ts);
  });

  it('tasksInFlight and blocked ignore tasks of closed features', () => {
    const closed = feat('c', 'done', [task('a', 'IN_TESTING'), task('b', 'BLOCKED')]);
    const open = feat('o', 'implement', [task('c', 'IN_PROGRESS'), task('d', 'BLOCKED')]);
    const k = buildKPIs([closed, open]);
    expect(k.tasksInFlight).toBe(1);
    expect(k.blocked).toBe(1);
    expect(buildKPIs([closed]).tasksInFlight).toBe(0);
  });
});

describe('KPI scoping', () => {
  const a = feat('a', 'implement', [task('1', 'IN_PROGRESS')], { history: [{ tokens_k: 100, subagent: 'x', status: 'DONE' }] });
  const b = feat('b', 'implement', [task('2', 'TODO')], { history: [{ tokens_k: 50, subagent: 'x', status: 'DONE' }] });
  const c = feat('c', 'done', [task('3', 'DONE')], { history: [{ tokens_k: 10, subagent: 'x', status: 'DONE' }] });
  const all = [a, b, c];

  it('no filter covers every feature', () => {
    expect(featuresInScope(applyFilters(all, EMPTY_FILTERS), EMPTY_FILTERS)).toHaveLength(3);
    expect(buildKPIs(all).agentSpend.featureCount).toBe(3);
  });

  it('a feature filter scopes tokens, spend and counts to the selected features', () => {
    const f = { ...EMPTY_FILTERS, featureIds: ['b', 'c'] };
    const scoped = featuresInScope(applyFilters(all, f), f);
    expect(scoped.map((x) => x.id)).toEqual(['b', 'c']);
    const k = buildKPIs(scoped);
    expect(k.agentSpend.tokens).toBe(60_000);
    expect(k.tasksInFlight).toBe(0);
    expect(k.activeFeatures).toBe(1);
  });
});

describe('task-less features in scope', () => {
  const quick = feat('q', 'done', [], { history: [{ tokens_k: 120, subagent: 'x', status: 'DONE' }] });
  const other = feat('o', 'implement', [task('1', 'TODO')], { history: [{ tokens_k: 5, subagent: 'x', status: 'DONE' }] });

  it('keeps a task-less feature selected by id', () => {
    const f = { ...EMPTY_FILTERS, featureIds: ['q'] };
    const scoped = featuresInScope(applyFilters([quick, other], f), f);
    expect(scoped.map((x) => x.id)).toEqual(['q']);
    const k = buildKPIs(scoped);
    expect(k.agentSpend.featureCount).toBe(1);
    expect(k.agentSpend.tokens).toBe(120_000);
  });

  it('drops task-less features when a task-level filter is active', () => {
    const f = { ...EMPTY_FILTERS, featureIds: ['q', 'o'], statuses: ['TODO' as const] };
    expect(featuresInScope(applyFilters([quick, other], f), f).map((x) => x.id)).toEqual(['o']);
  });
});

describe('tokens agree with Spend by model', () => {
  it('uses the history sum (same source as the panel), not by_subagent', () => {
    const history = [
      { subagent: 'dev', model: 'sonnet', tokens_k: 100, status: 'DONE' },
      { subagent: 'cli', model: 'inherit', tokens_k: 36.5, status: 'DONE' },
    ];
    const f = feat('t', 'implement', [], {
      history,
      totals: { by_subagent: { dev: { calls: 1, approved: 0, retried: 0, time_s: 1, tokens_k: 100 } } },
    });
    const panel = aggregateByModel(history).reduce((s, r) => s + r.tokens_k, 0);
    expect(featureTokensK(f)).toBe(panel);
    expect(buildKPIs([f]).agentSpend.tokens).toBe(Math.round(panel * 1000));
  });
});

describe('spendBudgetLine', () => {
  it('shows the percentage only for exactly one feature', () => {
    expect(spendBudgetLine({ dollars: 39, tokens: 0, budget: 78, featureCount: 1 })).toEqual({
      label: '50% of $78 feature budget',
      pct: 50,
    });
    const many = spendBudgetLine({ dollars: 300, tokens: 0, budget: 78, featureCount: 3 });
    expect(many.pct).toBeNull();
    expect(many.label).toBe('3 features · avg $100.00 each');
  });
});

describe('status column collapse', () => {
  it('collapses empty status columns only', () => {
    const f = feat('a', 'implement', [task('1', 'TODO')]);
    const cols = bucketBoard([f], 'status');
    expect(cols.filter((c) => isCollapsedColumn('status', c)).length).toBe(cols.length - 1);
    expect(isCollapsedColumn('status', cols.find((c) => c.key === 'TODO')!)).toBe(false);
    expect(isCollapsedColumn('tag', { items: [] })).toBe(false);
  });
});
