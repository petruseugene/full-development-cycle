# Parallel groups

How the orchestrator turns the task list in the tasks file (plan.md, or spec.md `## Tasks`) into batches it
can dispatch in parallel. Computed fresh from each task's `Touches:`
and `Depends on:` fields on every iteration — the human-readable
`## Execution plan` overview in the tasks file is documentation, not input.

Referenced from `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md` (step 2 dispatch
table) and lifecycle §1 step 8 (`../../playbook/references/lifecycle.md`,
i.e. `${CLAUDE_PLUGIN_ROOT}/skills/playbook/references/lifecycle.md`).

## Algorithm

`node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs groups [--all] [--json]` computes the partition from the tasks file (plan.md, or spec.md `## Tasks`); the
orchestrator dispatches what it prints and does not hand-derive groups.
Topological sort by `Depends on`, then within each tier partition into
glob-disjoint batches. Done, `[IMPL-DONE]`, `[BLOCKED]` and `owner`-tagged
tasks are excluded. A task with no `Touches:` runs alone.

```
inputs: tasks (each with Touches[], Depends on[])

1. tiers = topological_sort(tasks, by="Depends on")

2. for each tier in tiers:
     groups_in_tier = []
     remaining = tier
     while remaining:
         batch = [remaining[0]]
         batch_globs = remaining[0].Touches
         for task in remaining[1:]:
             if glob_disjoint(task.Touches, batch_globs):
                 batch.append(task)
                 batch_globs += task.Touches
         groups_in_tier.append(batch)
         remaining = remaining - batch

3. groups = flatten(tiers' groups in tier order)
```

Two glob sets are **disjoint** if no pair of patterns across them may
match a common path. The check is conservative: literal path segments are
compared up to the first wildcard (a mismatch proves disjointness), a plain
path is tested against the other pattern with `matchesGlob`, and anything
undecidable counts as overlapping. Unlike expanding via `git ls-files`, this
also catches files that do not exist yet.

Sequential between groups, parallel within. A group of size 1 is just
a serial dispatch.

## Dispatch pattern

How the orchestrator runs one group (and the end-of-feature gates):

1. Mark every task in the group `[IN PROGRESS]`, then send ONE assistant
   message containing one `Agent` call per task. Calls in the same message
   run concurrently; calls in separate messages run one after another.
2. Make each prompt self-contained: the subagent sees none of your
   context. Start it with the read-by-path template, where `<root>` is the
   plugin root recorded at run start and `<x>` the skill directory:
   "Read `<root>/skills/<x>/SKILL.md` and follow it. `${CLAUDE_PLUGIN_ROOT}`
   means `<root>`; `references/…` paths are relative to `<root>/skills/<x>/`.
   Do not call the Skill tool for dev-cycle skills." The same template
   covers fallback dispatches (dev-cycle:cli-fallback) and nested
   dispatches named by any skill. Set the `model` parameter (resolved per
   lifecycle §10 in `../../playbook/references/lifecycle.md`), and require
   the playbook core §6 YAML report at the end. Include the brief path (`briefs/task-<n>.md`), the CLI path
   (`${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs`), the task's `Touches:`
   globs, and the constraints: edit only files inside `Touches:` (report
   anything else under `touches_expanded:`), and never run `git stash`,
   `git checkout`, `git reset` or `git commit` in the shared working tree.
3. Wait for every report in the group before starting the next group.
   Never interrupt, cancel or re-dispatch an in-flight sibling because
   another one finished or failed; handle failures after the group ends.
4. Process the reports together: check `touches_expanded:` for collisions,
   apply the routing rules, then compute the next group.
5. End-of-feature gates use the same fan-out: one message, one `Agent`
   call per enabled gate, all reports collected before aggregating.

## Worked example

Five tasks in the tasks file:

| Task | Touches | Depends on |
|---|---|---|
| 1 | `db/migrations/**`, `db/schema.sql` | — |
| 2 | `api/types.ts` | — |
| 3 | `api/posts/**`, `api/types.ts` | 1, 2 |
| 4 | `api/users/**` | 1, 2 |
| 5 | `web/components/PostList/**` | 3 |

Topological sort produces three tiers:

- Tier A: `{1, 2}` (no deps)
- Tier B: `{3, 4}` (deps satisfied by tier A)
- Tier C: `{5}` (deps satisfied by tier B)

Within each tier, partition by disjoint `Touches`:

- Tier A: `1.Touches ∩ 2.Touches = ∅` → one group `{1, 2}`
- Tier B: `3.Touches ∩ 4.Touches = ∅` (posts vs users) → one group `{3, 4}`
- Tier C: single task → group `{5}`

Resulting execution plan:

```
Group 1 (parallel): Task 1, Task 2
Group 2 (parallel): Task 3, Task 4
Group 3 (serial):   Task 5
```

If task 3's `Touches` were instead `api/posts/**`, `api/users/types.ts`
(touching `api/users/**`), tier B would serialize: group `{3}` then
group `{4}`, because `glob_disjoint(3.Touches, 4.Touches)` is false.

## Dashboard rendering

One row per group, parallel tasks rendered side-by-side under the
running phase. The header's `▶ Running:` line lists every in-flight
task, comma-separated, when a group of size ≥ 2 is dispatched.

```
▶ Running: frontend-dev (Task 3: posts API), backend-dev (Task 4: users API)
```

Per-event lines still print one row per task so the user can see each
report land independently:

```
▶ [14h-02m] frontend-dev  starting   Task 3: posts API
▶ [14h-02m] backend-dev   starting   Task 4: users API
✓ [14h-05m] backend-dev   DONE       Task 4: users API (3m 12s, ~8.4k tok)
✓ [14h-06m] frontend-dev  DONE       Task 3: posts API (4m 01s, ~11.2k tok)
```

The full per-subagent table at phase boundaries is unchanged — it
aggregates across the entire feature.

## Central shared files serialize tasks

Files that nearly every task touches force serialization. Common
offenders:

- `package.json`, `package-lock.json`, `pnpm-lock.yaml`
- `tsconfig.json`, `jsconfig.json`
- `next.config.js`, `vite.config.ts`, build configs
- Top-level `index.ts` / `index.tsx` re-export barrels
- Shared `types.ts` modules referenced across the API

If five tasks each declare `package.json` in `Touches`, they all
collide in the same tier and run one at a time. This is the right
behavior: concurrent writes to a single JSON file race and corrupt.

Mitigation guidance for plan-writer:

- Only list `package.json` in `Touches` when the task actually adds a
  dependency. Don't list it defensively.
- Prefer per-feature module barrels over a single top-level `index.ts`
  when feasible.
- A shared `types.ts` is often a sign that two tasks should be merged
  or one should depend on the other, not run in parallel.

If parallelism in a feature collapses to mostly groups of size 1, the
plan-writer's `Touches` estimates are probably too broad — re-running
plan-writer with the discovered overlaps is a valid recovery.
