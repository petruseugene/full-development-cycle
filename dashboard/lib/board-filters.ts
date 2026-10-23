import type { Feature, Task, TaskStatus, TaskTag } from './types';

export type Filters = {
  statuses: TaskStatus[]; // empty = no filter on this dim
  tags: TaskTag[]; // empty = no filter
  featureIds: string[]; // empty = no filter
  flags: ('owner' | 'content')[]; // empty = no filter; selected flag keeps only tasks having it
};

export const EMPTY_FILTERS: Filters = { statuses: [], tags: [], featureIds: [], flags: [] };

export function activeFilterCount(f: Filters): number {
  return f.statuses.length + f.tags.length + f.featureIds.length + f.flags.length;
}

/**
 * AND across dimensions; OR within a dimension. Empty dimension = match-all.
 *
 * Preserves feature ordering. A feature whose `tasks` go empty after filtering
 * is still returned (with an empty `tasks` array) so downstream callers that
 * rely on the feature list (KPIs, grouping helpers) are not surprised by
 * disappearing features.
 */
export function applyFilters(features: Feature[], filters: Filters): Feature[] {
  const { statuses, tags, featureIds } = filters;
  const flags = filters.flags ?? [];
  const hasStatus = statuses.length > 0;
  const hasTag = tags.length > 0;
  const hasFeature = featureIds.length > 0;
  const hasFlags = flags.length > 0;

  if (!hasStatus && !hasTag && !hasFeature && !hasFlags) return features;

  return features.map((feature) => {
    if (hasFeature && !featureIds.includes(feature.id)) {
      return { ...feature, tasks: [] };
    }
    const filteredTasks = feature.tasks.filter((task) => {
      if (hasStatus && !statuses.includes(task.status)) return false;
      if (hasTag && !tags.includes(task.tag)) return false;
      if (hasFlags && !flags.some((fl) => task[fl])) return false;
      return true;
    });
    return { ...feature, tasks: filteredTasks };
  });
}

/**
 * Features the board actually shows for `filters` (output of applyFilters).
 * With no filter that is every feature; with a task-level filter (status/tag/flag), features left
 * without tasks are dropped so KPIs cover the same set as the visible cards;
 * with only a feature selection, the selected features are kept as-is.
 */
export function featuresInScope(filtered: Feature[], filters: Filters): Feature[] {
  if (activeFilterCount(filters) === 0) return filtered;
  const taskLevel =
    filters.statuses.length > 0 || filters.tags.length > 0 || (filters.flags ?? []).length > 0;
  if (taskLevel) return filtered.filter((f) => f.tasks.length > 0);
  // Feature selection only: keep exactly the selected features, including
  // task-less (quick/lite) ones that have no plan tasks to show.
  return filtered.filter((f) => filters.featureIds.includes(f.id));
}

// ---------------------------------------------------------------------------
// Group: re-bucketing the board by status / feature / tag / agent.
// ---------------------------------------------------------------------------

export type GroupKey = 'status' | 'feature' | 'tag' | 'agent';

export const GROUP_KEY_LABELS: Record<GroupKey, string> = {
  status: 'Status',
  feature: 'Feature',
  tag: 'Tag',
  agent: 'Agent',
};

export type Column = {
  key: string;           // status value, feature.id, tag, agent name, or 'unassigned' / 'other'
  label: string;         // visible heading
  dot?: string;          // CSS class for the column dot (status only)
  pulse?: boolean;       // status only
  items: { task: Task; feature: Feature }[];
};

type StatusColumnKey = TaskStatus | 'WAITING_OWNER';

const STATUS_COLUMNS: { key: StatusColumnKey; label: string; dot: string; pulse?: boolean }[] = [
  { key: 'TODO', label: 'To do', dot: 'todo' },
  { key: 'IN_PROGRESS', label: 'In progress', dot: 'progress', pulse: true },
  { key: 'IN_TESTING', label: 'Testing', dot: 'testing' },
  { key: 'BLOCKED', label: 'Blocked', dot: 'blocked' },
  { key: 'WAITING_OWNER', label: 'Waiting for owner', dot: 'blocked' },
  { key: 'DONE', label: 'Merged', dot: 'done' },
];

const TAG_COLUMNS: { key: TaskTag; label: string }[] = [
  { key: 'frontend', label: 'Frontend' },
  { key: 'backend', label: 'Backend' },
  { key: 'mixed', label: 'Mixed' },
  { key: 'infra', label: 'Infra' },
];

/**
 * Status board only: an empty column collapses to a compact header + count so
 * populated columns get the width. Other groupings already hide empty buckets.
 */
export function isCollapsedColumn(groupKey: GroupKey, col: Pick<Column, 'items'>): boolean {
  return groupKey === 'status' && col.items.length === 0;
}

export function bucketBoard(
  features: Feature[],
  groupKey: GroupKey,
  maxColumns = 8,
): Column[] {
  const all: { task: Task; feature: Feature }[] = [];
  for (const f of features) for (const t of f.tasks) all.push({ task: t, feature: f });

  if (groupKey === 'status') {
    // Pre-seed buckets so empty status columns are preserved.
    const buckets: Record<StatusColumnKey, { task: Task; feature: Feature }[]> = {
      TODO: [],
      IN_PROGRESS: [],
      IN_TESTING: [],
      BLOCKED: [],
      WAITING_OWNER: [],
      DONE: [],
    };
    for (const item of all) {
      const key: StatusColumnKey =
        item.task.owner && item.task.status !== 'DONE' ? 'WAITING_OWNER' : item.task.status;
      buckets[key].push(item);
    }
    return STATUS_COLUMNS.map((col) => ({
      key: col.key,
      label: col.label,
      dot: col.dot,
      pulse: col.pulse,
      items: buckets[col.key],
    }));
  }

  if (groupKey === 'feature') {
    // Feature-array order. First N render individually; rest -> Other.
    const inHead = features.slice(0, maxColumns);
    const inTail = features.slice(maxColumns);
    const headIds = new Set(inHead.map((f) => f.id));

    const columns: Column[] = [];
    for (const feature of inHead) {
      const items = all.filter((it) => it.feature.id === feature.id);
      if (items.length === 0) continue; // hide empty
      columns.push({
        key: feature.id,
        label: feature.title,
        items,
      });
    }
    if (inTail.length > 0) {
      const tailItems = all.filter((it) => !headIds.has(it.feature.id));
      if (tailItems.length > 0) {
        columns.push({ key: 'other', label: 'Other', items: tailItems });
      }
    }
    return columns;
  }

  if (groupKey === 'tag') {
    const columns: Column[] = [];
    for (const col of TAG_COLUMNS) {
      const items = all.filter((it) => it.task.tag === col.key);
      if (items.length === 0) continue; // hide empty
      columns.push({ key: col.key, label: col.label, items });
    }
    return columns;
  }

  // groupKey === 'agent'
  // One column per distinct value across all tasks' activeAgents.
  // Tasks with empty/undefined activeAgents -> Unassigned (final column).
  // If >maxColumns distinct named agents, take first 8 alphabetically + Other.
  const agentSet = new Set<string>();
  let hasUnassigned = false;
  for (const { task } of all) {
    const agents = task.activeAgents;
    if (!agents || agents.length === 0) {
      hasUnassigned = true;
      continue;
    }
    for (const a of agents) agentSet.add(a);
  }

  const sortedAgents = Array.from(agentSet).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  const headAgents = sortedAgents.slice(0, maxColumns);
  const tailAgents = sortedAgents.slice(maxColumns);
  const tailSet = new Set(tailAgents);

  const columns: Column[] = [];
  for (const name of headAgents) {
    const items = all.filter((it) => {
      const agents = it.task.activeAgents;
      if (!agents) return false;
      return (agents as readonly string[]).includes(name);
    });
    if (items.length === 0) continue;
    columns.push({ key: name, label: name, items });
  }
  if (tailAgents.length > 0) {
    const tailItems = all.filter((it) => {
      const agents = it.task.activeAgents;
      if (!agents || agents.length === 0) return false;
      return agents.some((a) => tailSet.has(a));
    });
    if (tailItems.length > 0) {
      columns.push({ key: 'other', label: 'Other', items: tailItems });
    }
  }
  if (hasUnassigned) {
    const unassignedItems = all.filter((it) => {
      const agents = it.task.activeAgents;
      return !agents || agents.length === 0;
    });
    if (unassignedItems.length > 0) {
      columns.push({ key: 'unassigned', label: 'Unassigned', items: unassignedItems });
    }
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Sort: order items within a column by recency / title / status.
// ---------------------------------------------------------------------------

export type SortKey = 'recent' | 'title' | 'status';

export const SORT_KEY_LABELS: Record<SortKey, string> = {
  recent: 'Recent',
  title: 'Title',
  status: 'Status',
};

const STATUS_RANK: Record<TaskStatus, number> = {
  IN_PROGRESS: 0,
  IN_TESTING: 1,
  BLOCKED: 2,
  TODO: 3,
  DONE: 4,
};

function tsToMs(ts: string | undefined): number {
  if (!ts) return 0;
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}

/**
 * Recency timestamp per (task, feature) — see spec R3 / AC3.1:
 *   1. Latest `feature.reviews[i].ts` whose `taskId === task.id`.
 *   2. Else latest `feature.meta.history[*].ts` whose `task_id === task.id`;
 *      if no history entries carry a matching task id, fall back to the
 *      latest history `ts` on the feature as a whole.
 *   3. Else `feature.updatedAt`.
 *   4. Else `0` (epoch — deterministic but tie-breakable by stable sort).
 */
function recencyMs(task: Task, feature: Feature): number {
  let latest = 0;
  for (const r of feature.reviews ?? []) {
    if (r.taskId !== task.id) continue;
    const t = tsToMs(r.ts);
    if (t > latest) latest = t;
  }
  if (latest > 0) return latest;

  const history = feature.meta?.history ?? [];
  let perTask = 0;
  let anyHistory = 0;
  for (const h of history) {
    const t = tsToMs(h.ts);
    if (t > anyHistory) anyHistory = t;
    if (h.task_id && h.task_id === task.id && t > perTask) perTask = t;
  }
  if (perTask > 0) return perTask;
  if (anyHistory > 0) return anyHistory;

  const upd = tsToMs(feature.updatedAt);
  if (upd > 0) return upd;
  return 0;
}

/**
 * Sort the items inside a single column. Stable; does not mutate `items`.
 * Sort rules per spec R3:
 *   - 'recent' (default): most-recently-updated first (descending recencyMs).
 *   - 'title':  case-insensitive `localeCompare` on `task.title`.
 *   - 'status': ascending by STATUS_RANK[task.status]; ties broken by recency
 *               (descending — newer first within the same status).
 */
export function sortColumnItems(
  items: { task: Task; feature: Feature }[],
  sortKey: SortKey,
): { task: Task; feature: Feature }[] {
  const copy = items.slice();

  if (sortKey === 'title') {
    copy.sort((a, b) =>
      a.task.title.localeCompare(b.task.title, undefined, { sensitivity: 'base' }),
    );
    return copy;
  }

  if (sortKey === 'status') {
    copy.sort((a, b) => {
      const ra = STATUS_RANK[a.task.status];
      const rb = STATUS_RANK[b.task.status];
      if (ra !== rb) return ra - rb;
      // Tie-break: newer first within the same status.
      return recencyMs(b.task, b.feature) - recencyMs(a.task, a.feature);
    });
    return copy;
  }

  // 'recent' — newer first.
  copy.sort(
    (a, b) => recencyMs(b.task, b.feature) - recencyMs(a.task, a.feature),
  );
  return copy;
}
