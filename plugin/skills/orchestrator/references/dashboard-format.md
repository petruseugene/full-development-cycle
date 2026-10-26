# Dashboard format

Render between phases and on user demand. Use ASCII (no emoji unless user opts in).

## Status legend

Per-task status markers that appear in the tasks file and the dashboard's
event lines (see playbook core §3 in `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md`, and design §11):

| Status         | Meaning                                                       |
|----------------|---------------------------------------------------------------|
| `[TODO]`       | Not started                                                   |
| `[IN PROGRESS]`| Implementer running (initial or fix cycle)                    |
| `[IMPL-DONE]`  | Implementer reported DONE; awaiting end-review                |
| `[IN REVIEW]`  | Has findings in active fix cycle                              |
| `[BLOCKED]`    | 3 cycles exhausted, BLOCKED report, or unresolvable conflict  |
| `[DONE]`       | End-review approved + feature commit landed                   |

`[IN TESTING]` is removed — there is no per-task testing phase
anymore. End-gates (review, static-check, auto-test, visual, a11y,
deps, security) run once per feature against the whole-feature diff.

## Header block

```
╭─ Feature: <YYYY-MM-DD-HHh-MMm-slug> ─────────────────────────────────╮
│ Flow: <feature|bugfix>   Phase: <phase>   Elapsed: <Xm Ys>           │
│ Progress: [<bar>] <done>/<total> tasks (<pct>%)                      │
├──────────────────────────────────────────────────────────────────────┤
│ ▶ Running: <subagent>   (<context, e.g. Task 9: <name>>)             │
```

Progress bar: 12 cells, `█` for done, `░` for remaining. Round to nearest cell.

## Per-subagent table

```
├──────────────────┬─────────┬───────┬──────────┬─────────┬─────────┬────────────┤
│ Subagent         │ Model   │ Calls │ Approved │ Retried │ Time    │ Tokens (~) │
├──────────────────┼─────────┼───────┼──────────┼─────────┼─────────┼────────────┤
│ <name>           │ <model> │ <n>   │ <n|—>    │ <n>     │ <Xm Ys> │ <N.Nk>     │
... one row per subagent that has been called at least once ...
├──────────────────┼─────────┼───────┼──────────┼─────────┼─────────┼────────────┤
│ Total            │         │ <Σ>   │ <Σ>      │ <Σ>     │ <Σ>     │ <Σ>        │
╰──────────────────┴─────────┴───────┴──────────┴─────────┴─────────┴────────────╯
```

`Approved` is `—` (em dash) for subagents that don't go through review (discovery, wireframer, etc.).

`Model` is the subagent's resolved model (`opus`, `sonnet`, `haiku`, or
`inherit`). When its calls ran on more than one model, the cell shows `mixed`.

## Per-model table

Sourced from `feature.json.totals.by_model`. One row per model, a `Total`
row, and an `unknown` row only when legacy entries without `model` exist.

```
├─────────┬───────┬─────────┬────────────┤
│ Model   │ Calls │ Time    │ Tokens (~) │
├─────────┼───────┼─────────┼────────────┤
│ opus    │ 3     │ 2m 34s  │ 13.2k      │
│ sonnet  │ 3     │ 5m 45s  │ 23.2k      │
│ haiku   │ 1     │ 0m 20s  │ 1.0k       │
├─────────┼───────┼─────────┼────────────┤
│ Total   │ 7     │ 8m 39s  │ 37.4k      │
╰─────────┴───────┴─────────┴────────────╯
```

## Per-event line (on each dispatch start/finish)

```
▶ [HHh-MMm] <subagent>   starting   <context>
✓ [HHh-MMm] <subagent>   <status>   <context> (<duration>, ~<tokens>k tok)
```

Statuses for the per-event line are the report's `status` field verbatim (`DONE`, `APPROVED`, `CHANGES_REQUIRED`, `PASSED`, `FAILED`, `BLOCKED`).

## Parallel-group rows (implement phase)

When the orchestrator dispatches a parallel group of implementers in
one message (design §6.1), the dashboard renders the in-flight tasks
side-by-side under a `▶ Group <n>` header. Each row shows the task id,
its current status, the running subagent, and elapsed time. The group
header collapses to a single line once every task in the group has
reported.

Example — a 4-task feature where the orchestrator built two groups:
Group 1 = Task 1 alone (foundation), Group 2 = Tasks 2, 3, 4 dispatched
in parallel because their `Touches:` globs are disjoint:

```
╭─ Feature: 2026-05-16-09h-12m-posts-api ──────────────────────────────╮
│ Flow: feature   Phase: implement   Elapsed: 6m 22s                   │
│ Progress: [██████░░░░░░] 1/4 tasks (25%)                             │
├──────────────────────────────────────────────────────────────────────┤
│ ▶ Group 2 (parallel, 3 tasks):                                       │
│   Task 2  [IN PROGRESS]  backend-dev    1m 47s                       │
│   Task 3  [IMPL-DONE]    backend-dev    2m 03s   ✓                   │
│   Task 4  [IN PROGRESS]  frontend-dev   1m 47s                       │
├──────────────────────────────────────────────────────────────────────┤
│ Plan:                                                                │
│   Task 1  [IMPL-DONE]    db schema + types          (Group 1)        │
│   Task 2  [IN PROGRESS]  posts service              (Group 2)        │
│   Task 3  [IMPL-DONE]    posts API endpoints        (Group 2)        │
│   Task 4  [IN PROGRESS]  posts list UI              (Group 2)        │
├──────────────────┬─────────┬───────┬──────────┬─────────┬─────────┬────────────┤
│ Subagent         │ Model   │ Calls │ Approved │ Retried │ Time    │ Tokens (~) │
├──────────────────┼─────────┼───────┼──────────┼─────────┼─────────┼────────────┤
│ discovery        │ opus    │ 1     │ —        │ 0       │ 0m 38s  │ 3.1k       │
│ spec-writer      │ opus    │ 1     │ —        │ 0       │ 0m 52s  │ 4.4k       │
│ plan-writer      │ opus    │ 1     │ —        │ 0       │ 1m 04s  │ 5.7k       │
│ backend-dev      │ mixed   │ 3     │ —        │ 0       │ 4m 18s  │ 18.2k      │
│ frontend-dev     │ sonnet  │ 1     │ —        │ 0       │ 1m 47s  │ 6.0k       │
├──────────────────┼─────────┼───────┼──────────┼─────────┼─────────┼────────────┤
│ Total            │         │ 7     │ —        │ 0       │ 8m 39s  │ 37.4k      │
╰──────────────────┴─────────┴───────┴──────────┴─────────┴─────────┴────────────╯
```

Notes:
- Sibling event lines for parallel implementers interleave naturally
  by completion time; the per-event line format is unchanged.
- Once every task in the group reaches `[IMPL-DONE]` (or `[BLOCKED]`),
  the `▶ Group <n>` block collapses to:
  `✓ Group 2 done — 3 tasks IMPL-DONE in 2m 41s`.
- The end-gate phase renders a similar parallel block titled
  `▶ End-gates (parallel, N gates):` with one row per dispatched gate
  (`static-check`, `review`, `auto-test`, `visual-test`, `a11y`,
  `deps-audit`, `security` — whichever are enabled).

## Owner waiting line

Tasks tagged `owner` are manual steps for the project owner; they are never
dispatched. At every phase boundary while any owner task is not `DONE`, and
immediately before `dod`, the orchestrator prints one line per open owner
task (below the dashboard when it is rendered):

```
> OWNER: Task <n> — <title> (waiting)
```

`<n>` and `<title>` come from the tasks source. The line disappears once the
user explicitly confirms that task in the conversation and the orchestrator
runs `task <n> status DONE`; completion is never inferred.

## When the dashboard isn't shown

- Inside a per-event line is enough during long phases.
- The full table renders at: phase boundary, after escalation, at final report, or when user asks ("show progress").

## Budget warning line

When a budget key in effect is exceeded, the orchestrator emits **exactly
one** warning line immediately below the per-subagent table (or below the
per-event line when only a single event is being rendered). The warning
never aborts the run and never blocks the dod-gate.

### Thresholds

Read from `feature.json.budget` (optional). Shape, with at least one key:

```json
"budget": { "usd": <number>, "tokens_k": <int>, "time_s": <int> }
```

If `budget` is absent, defaults apply: `{usd: 50, time_s: 7200}`. There is no
default `tokens_k` check.

| Key | Compared against |
|---|---|
| `usd` | `totals.measured.usd_est`; skipped when `totals.measured.measured_entries == 0` |
| `tokens_k` | sum of history `tokens_k` over counted entries plus the orchestrator entry (billable for measured entries) |
| `time_s` | `totals.time_s` |

A legacy budget such as `{tokens_k: 50, time_s: 3600}` is honoured as written.

### Format

```
! BUDGET: <reasons>; budget <k>=<v>, <k>=<v>
```

The `budget …` tail lists only the keys in effect (the budget's own keys, or
the defaults when absent). `<reasons>` is a comma-separated list of
`<key>=<current> exceeds <limit>` for each tripped key, in the order `usd`,
`tokens_k`, `time_s`. Exactly one line is emitted regardless of how many
thresholds are crossed.

### Scenarios (hand-traced)

1. **usd trip, no budget key** — `totals.measured.usd_est = 60`,
   `measured_entries > 0`, `totals.time_s = 0`, no `budget`. Defaults apply
   (`usd=50`, `time_s=7200`). Only usd trips. Output: exactly one line —
   `! BUDGET: usd_est=60 exceeds 50; budget usd=50, time_s=7200`

2. **No trip** — `usd_est = 12`, `time_s = 300`, no `budget`. Zero warning lines.

3. **Custom budget honoured** — `usd_est = 60`, `budget = { "usd": 100, "time_s": 7200 }`.
   60 < 100 and time is under. Zero warning lines.

4. **Legacy budget honoured** — `budget = { "tokens_k": 50, "time_s": 3600 }`,
   summed `tokens_k = 60`, `time_s = 0`. Only the keys in effect are checked
   (no usd check). Tokens trip. Output: exactly one line —
   `! BUDGET: tokens_k=60 exceeds 50; budget tokens_k=50, time_s=3600`

5. **No measured data** — `measured_entries = 0`, no `budget`. The usd check is
   skipped; only `time_s` can trip.
