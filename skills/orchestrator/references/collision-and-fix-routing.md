# Collision detection and fix routing

How the orchestrator handles two failure modes specific to parallel
dispatch: (1) two sibling implementers in the same group wrote to the
same file, and (2) end-gate findings need to be routed back to the
right task(s) for a fix cycle.

Referenced from `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md` (step 4 routing)
and lifecycle §1 step 9 + §7 routing table (`../../playbook/references/lifecycle.md`,
i.e. `${CLAUDE_PLUGIN_ROOT}/skills/playbook/references/lifecycle.md`).

## Collision detection (post-group)

After every parallel group completes, the orchestrator compares the
files each sibling actually wrote.

```
inputs: group (list of completed task reports)

all_writes = {
    task.id: set(task.Touches_expanded_to_paths)
             ∪ set(task.report.touches_expanded or [])
    for task in group
}

for task_a, task_b in pairs(group):    # all unordered pairs
    overlap = all_writes[task_a] ∩ all_writes[task_b]
    if overlap:
        log conflict in feature.json.history with overlap paths
        victim = later_in_plan_order(task_a, task_b)
        victim.cycle_count += 1
        if victim.cycle_count > 3:
            mark victim [BLOCKED]; escalate
        else:
            mark victim [IN PROGRESS] for serial re-dispatch
            next iteration: dispatch victim alone with conflict note
```

Status flips and history entries go through `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs`:
the conflict is logged with `history add --phase conflict --subagent
orchestrator --status CONFLICT --summary "<paths>"`, and the victim is set
with `task <n> status "IN PROGRESS"` (or `BLOCKED` past the limit). No hand
edits of the tasks file (plan.md, or spec.md `## Tasks`) or feature.json.

Notes:

- Only **pairwise** overlap matters. Three-way collisions surface as
  three separate pairs, each handled the same way.
- The non-victim task keeps its work — only the later task is rolled
  back and re-run serially. This preserves the earlier task's diff so
  the re-dispatched victim builds on top of it.
- Collision counts against the **same** 3-cycle budget as
  review/test cycles. A task that collides three times is `[BLOCKED]`.

### Victim selection rule

> **The task with the higher index in plan order is the victim.**

Rationale: plan order is the user's stated priority. The earlier task
is more likely foundational; the later task is more likely a leaf and
cheaper to re-run. Plan order is stable across iterations, so this
rule is deterministic.

Ties cannot occur — task IDs are unique within a plan.

## End-gate fix routing

When end-gates fail, the orchestrator routes findings back to specific
tasks before re-dispatching implementers.

### Per-task findings

`review.md` is structured by `## Task N — <name>` sections (see
`dev-cycle:code-reviewer` skill contract). Findings under a task header route
directly to that task's implementer.

### Cross-cutting findings

Findings under `## Cross-cutting` in `review.md`, or findings from
other gates (static-check, whose findings come from the CLI's `static-check-report.md`; auto-test, visual, a11y, deps, security)
that don't carry an explicit task tag, are routed by **glob overlap
with affected files**.

```
inputs:
  finding.affected_files = [paths surfaced by the gate's report]
  tasks = all tasks in the tasks file (plan.md, or spec.md `## Tasks`)

best_task = argmax(
    task ∈ tasks,
    count(p ∈ finding.affected_files : p matches any glob in task.Touches)
)

if max_overlap == 0:
    escalate to user with the finding text — do not guess
else:
    route finding to best_task
    best_task.cycle_count += 1
    status → [IN REVIEW]   # dev-cycle.mjs task <n> status "IN REVIEW"
```

Failures of profile extra gates (`gate.<name>`) route the same way, using
the file paths found in `gates/<name>.log`; if the log names no paths, or
none overlap a task's `Touches`, escalate to the user.

Ties (two tasks with equal overlap count) resolve by **earlier plan
order wins** — opposite of the collision victim rule, because here
we're attributing root cause rather than rescheduling.

### Only-failed-gates re-run

After fix dispatches complete:

```
re-run gates = { g for g in end_gates if g.last_status ∉ pass_set }
```

Gates that previously `PASSED` / `APPROVED` are **not** re-run. The
design assumption is that:

- Static-check passing once means the syntax tree was clean.
  Subsequent fixes are caught by the re-run of `dev-cycle:code-reviewer`.
- Auto-test passing once means tests existed and ran. New code from a
  fix gets test coverage only if `dev-cycle:auto-tester` itself is in the
  failing set.

If a fix introduces a regression in a previously-passing gate, the
final `dod-gate` will still catch it via the history scan — but only
after the orchestrator believes the cycle is complete. This is an
accepted v1 tradeoff (see design §6.4).

## Worked example

Four-task group dispatched in parallel:

| Task | Touches |
|---|---|
| A | `api/posts/**` |
| B | `api/types.ts`, `api/posts/handlers.ts` |
| C | `api/types.ts`, `api/users/**` |
| D | `web/components/UserCard/**` |

Reports come back:

- A: `DONE`, `touches_expanded: []`
- B: `DONE`, `touches_expanded: []`
- C: `DONE`, `touches_expanded: []`
- D: `DONE`, `touches_expanded: []`

Pairwise overlap check:

- A ∩ B: `api/posts/handlers.ts` ∈ both — **collision**
- A ∩ C: ∅
- A ∩ D: ∅
- B ∩ C: `api/types.ts` ∈ both — **collision**
- B ∩ D: ∅
- C ∩ D: ∅

Two collisions, two victims (later in plan order each time):

- A vs B → victim = B; `B.cycle_count = 1`; re-dispatch B serially next cycle
- B vs C → victim = C; `C.cycle_count = 1`; re-dispatch C serially next cycle

Result: A and D keep their work and advance to `[IMPL-DONE]`. B and C
go back to `[IN PROGRESS]` and run serially in the next iteration with
the conflict note attached:

```
Group 1' (serial): Task B  — conflict with Task A on api/posts/handlers.ts
Group 2' (serial): Task C  — conflict with Task B on api/types.ts
```

If B collides again on its serial re-run (cycle_count = 2), the next
collision sends it to cycle 3. A fourth collision marks it `[BLOCKED]`
with the conflict history attached.

## What this does not do

- Does **not** auto-merge sibling diffs. The victim's work is rolled
  back and re-run from scratch on top of the survivor's diff.
- Does **not** retry the survivor. Only the victim's `cycle_count`
  increments.
- Does **not** attempt to detect collisions across groups — by
  construction, groups are sequential, so a later group always sees
  the prior group's writes already committed to the working tree.
- Does **not** re-run already-passing end-gates after a fix cycle
  (see "Only-failed-gates re-run" above).
