// Parallel groups: topological tiers by `Depends on`, then greedy
// glob-disjoint batches in plan order. Pure; no I/O.

import { UsageError } from './core.mjs';
import { globsOverlap } from './glob-overlap.mjs';
import { isOwnerTask } from './plan.mjs';

const EXCLUDED = new Set(['IMPL-DONE', 'DONE', 'BLOCKED']);
const SATISFIED = new Set(['IMPL-DONE', 'DONE']);

function touchesOverlap(a, b) {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

/**
 * @param {Array<{n:number, tag:string, status:string, touches:string[], dependsOn:number[]}>} tasks
 * @param {{all?: boolean}} [opts]
 * @returns {{groups: number[][], held: number[]}}  `held` = tasks omitted
 *   because a dependency is BLOCKED/owner (never satisfied without --all).
 * @throws {UsageError} on a missing dependency or a cycle
 */
export function computeGroups(tasks, { all = false } = {}) {
  const byN = new Map(tasks.map((t) => [t.n, t]));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!byN.has(d)) throw new UsageError(`task ${t.n} depends on missing task ${d}`);
    }
  }

  let pool = all ? [...tasks] : tasks.filter((t) => !EXCLUDED.has(t.status) && !isOwnerTask(t));
  const held = [];
  if (!all) {
    // Drop tasks (transitively) waiting on a dep that is neither in the pool nor satisfied.
    for (let changed = true; changed;) {
      changed = false;
      const inPool = new Set(pool.map((t) => t.n));
      const next = pool.filter((t) => t.dependsOn.every((d) => inPool.has(d) || SATISFIED.has(byN.get(d).status)));
      if (next.length !== pool.length) {
        for (const t of pool) if (!next.includes(t)) held.push(t.n);
        pool = next;
        changed = true;
      }
    }
  }

  // Tier = longest dependency chain within the pool.
  const inPool = new Map(pool.map((t) => [t.n, t]));
  const tier = new Map();
  const visiting = new Set();
  const depthOf = (t, trail) => {
    if (tier.has(t.n)) return tier.get(t.n);
    if (visiting.has(t.n)) {
      const cycle = [...trail.slice(trail.indexOf(t.n)), t.n].join('→');
      throw new UsageError(`dependency cycle: ${cycle}`);
    }
    visiting.add(t.n);
    let d = 0;
    for (const dep of t.dependsOn) {
      const dt = inPool.get(dep);
      if (dt) d = Math.max(d, depthOf(dt, [...trail, t.n]) + 1);
    }
    visiting.delete(t.n);
    tier.set(t.n, d);
    return d;
  };
  for (const t of pool) depthOf(t, []);

  const groups = [];
  const maxTier = pool.length ? Math.max(...tier.values()) : -1;
  for (let k = 0; k <= maxTier; k++) {
    let remaining = pool.filter((t) => tier.get(t.n) === k);
    while (remaining.length) {
      const first = remaining[0];
      const batch = [first];
      if (first.touches.length > 0) {
        const globs = [...first.touches];
        for (const t of remaining.slice(1)) {
          if (t.touches.length > 0 && !touchesOverlap(t.touches, globs)) {
            batch.push(t);
            globs.push(...t.touches);
          }
        }
      }
      groups.push(batch.map((t) => t.n));
      remaining = remaining.filter((t) => !batch.includes(t));
    }
  }
  return { groups, held };
}
