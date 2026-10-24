# DoD Gate

The **Definition-of-Done gate** is an orchestrator-side aggregator that
runs once per feature, after visual-tests (or after the last task if
visual-tests are disabled) and **before** `git push` / `git merge`. It is not a
subagent — there is no dispatch, no YAML report, no separate skill. The
orchestrator reads `feature.json.history` and decides whether the push
may proceed.

Referenced from `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md` (§ "DoD gate")
and lifecycle §1 step 9 + §7 routing table (`../../playbook/references/lifecycle.md`,
i.e. `${CLAUDE_PLUGIN_ROOT}/skills/playbook/references/lifecycle.md`).

## Execution

The rule below is executed by `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs dod` (read-only; exit 0 = PASSED,
exit 1 = FAILED with the escalation line on stdout). The orchestrator
runs it and relays the result; it does not evaluate the rule by hand.

## Pass rule

> **Every required gate's last entry in `feature.json.history` must be
> `DONE`, `APPROVED`, or `PASSED`.**

"Last entry" means the most recent history record whose
`(phase, subagent, task?)` tuple identifies that gate. If a required
gate has **no** entry in history, the gate is missing and the dod-gate
fails.

The pass set is closed:

```
{ "DONE", "APPROVED", "PASSED" }
```

`DONE_WITH_CONCERNS` does **not** pass — the orchestrator must have
either resolved the concern (advancing the gate to `DONE`) or escalated
before reaching dod-gate. `NEEDS_CONTEXT`, `BLOCKED`, `CHANGES_REQUIRED`,
and `FAILED` never pass.

## Required gates

Derived from the flow, `track` and the `feature.json` flags. Tasks come from the
tasks source (plan.md, or spec.md `## Tasks` when there is no plan.md), minus tasks
tagged `owner`; `lite` uses `feature.json.areas` (written by the orchestrator via
`dev-cycle.mjs feature set areas '<json>'`), `quick` a single `implement`. A gate key
matches `history[].phase`. Per-task (or per-area) `implement` entries remain.
Review, static-check, and test entries collapse to feature-level since end-gates run
once per feature against the whole-feature diff (see design §4 step 10, §6.4, §7.2).
A `check --record` entry (phase `static-check`, written by the CLI's `check` verb)
satisfies the `static-check` gate. `git merge` runs dod before merging.

```
track = feature.json.track or "full"
quick_set = ["implement"]
owner_keys = ["owner.task=<n>" for each task tagged owner]  if feature.json.owner_blocking == true  else []
base  = quick_set                                                                  if flow in (bugfix, hotfix)   # regardless of any track key
      | ["spec", "plan"] + ["implement.task=<n>" ...] + owner_keys  if track == "full" and separate_plan != false   # absent = legacy
      | ["spec"]         + ["implement.task=<n>" ...] + owner_keys  if track == "full" and separate_plan == false
      | ["spec"] + ["implement.area=<name>" for each area in feature.json.areas]  if track == "lite"
      | ["implement"]                                                             if track == "quick"
      | ["implement.area=<name>" for each area in feature.json.areas]             if track == "polish"   # no spec, plan or task keys
required_gates = base
               + ["static-check"]                     # always
               + ["review"]                           # always
               + (["auto-test"]   if feature.json.auto_tests)
               + (["visual-test"] if feature.json.visual_tests)
               + (["a11y"]        if feature.json.a11y_audit)
               + (["deps-audit"]  if feature.json.dependency_audit)
               + (["security"]    if feature.json.security_review)
               + (["gate.<name>"  for each entry in feature.json.profile.extra_gates])
```

Bugfix and hotfix always use the quick set (`implement`, `static-check`, `review`,
then flag and extra gates): it contains neither `spec` nor `plan`, even when a
`track: "full"` key is present. Because `git merge` runs dod, the bugfix flow's
code-reviewer is therefore required.

With `separate_plan: false` the required set has no `plan` gate. If the tasks
source yields no tasks in that mode, dod fails with gate `tasks`:
`! DOD-GATE FAILED: tasks last status = MISSING; aborting before push.`

**Open decisions.** For flow `feature` on track `full` or `lite` (absent track = full), when spec.md exists and has any `### D<n>:` heading under `## Open decisions` (even malformed), dod fails with gate `decisions`:
`! DOD-GATE FAILED: decisions last status = OPEN; aborting before push.`
It is checked after `tasks` and before the history gates, is not a history gate and is not in the required set. Quick track, bugfix, hotfix and specs without the section are unaffected. Resolve it by re-running the decisions step (`open-decisions.md`), never by editing spec.md.

**Spec analyze.** For flow `feature`, track `full` or `lite` (absent = full), when spec.md exists, dod runs `analyzeSpec` and fails on any error (not warnings):
`! DOD-GATE FAILED: spec-analyze last status = ERRORS; aborting before push.`
It is checked after `decisions` and before the history gates, is not a history gate and is not in the required set. Quick track, bugfix and hotfix are unaffected. Fix it by re-dispatching the writer (`spec-analyze.md`), never by editing spec.md.

**Polish items.** On track `polish`, the `items` precondition runs before the gates and is not a history gate: `MISSING` when polish.md is absent or has 0 items; `OPEN` when any item is neither `IMPL-DONE`/`DONE` nor deferred with a non-empty reason (`polish defer <n> --reason`); otherwise `OK`. Failure prints `! DOD-GATE FAILED: items last status = OPEN; aborting before push.` `decisions` and `spec-analyze` are skipped on polish. Details: `polish.md`.

A lite feature with absent or empty `areas` fails with
`! DOD-GATE FAILED: implement.area=<none> last status = MISSING; aborting before push.`

| Gate key | Source phase | Required when |
|---|---|---|
| `spec` | spec-writer | track `full` or `lite` (not for bugfix/hotfix flows or track `quick`) |
| `plan` | plan-writer | track `full` only, and only when `separate_plan != false` (absent = required) |
| `implement.task=<n>` | frontend-dev / backend-dev | track `full`: every task in the tasks source (plan.md, or spec.md `## Tasks`) except tasks tagged `owner` |
| `owner.task=<n>` | the tasks source status (not history) | track `full`, only when `feature.json.owner_blocking == true`: one key per task tagged `owner`, placed after the `implement.task` keys |
| `implement.area=<name>` | frontend-dev / backend-dev | track `lite`: every entry in `feature.json.areas` |
| `implement.area=<name>` (polish) | frontend-dev / backend-dev | track `polish`: every entry in `feature.json.areas` (`implement.area=<none>` when empty) |
| `implement` | frontend-dev / backend-dev | track `quick`, and flow `bugfix` or `hotfix`: the single implementer |
| `static-check` | `check --record` entry, or dev-cycle:cli-fallback (tree-wide) | always (once per feature) |
| `review` | code-reviewer (whole-feature diff) | always (once per feature) |
| `auto-test` | auto-tester | once per feature, only when `feature.json.auto_tests == true` |
| `visual-test` | visual-tester | once per feature, only when `feature.json.visual_tests == true` |
| `a11y` | visual-tester (a11y mode) | once per feature, only when `feature.json.a11y_audit == true` |
| `deps-audit` | security-reviewer (dependency audit) | once per feature, only when `feature.json.dependency_audit == true` |
| `security` | security-reviewer | once per feature, only when `feature.json.security_review == true` |
| `gate.<name>` | `dev-cycle.mjs gate run` (profile extra gate) | once per feature, one per `profile.extra_gates` entry |

### Owner tasks (`owner.task=<n>`)

`owner_blocking` is a boolean interview key (default `false`; settable via
`--answer owner_blocking=true`, a profile default, or `feature set
owner_blocking true`). When it is `true`, `dod` adds one `owner.task=<n>` key
per owner task, after the `implement.task=<n>` keys. Unlike every other key,
it passes only when that task's status in the tasks source (plan.md, or
spec.md `## Tasks`) is `DONE` — history entries never satisfy it. The
orchestrator flips an owner task to `DONE` only after the user explicitly
confirms that task. A failing key prints the usual line, e.g.
`! DOD-GATE FAILED: owner.task=4 last status = TODO; aborting before push.`
When `owner_blocking` is `false` or absent, dod is unchanged and owner tasks
never block it.

The feature commit entry (the CLI's `git commit` / `ship`, or `dev-cycle:cli-fallback` as fallback) is **not** a required gate — the dod-gate
runs before the final push, and the single feature commit is
bookkeeping rather than verification.

## Escalation line format

On the first failing gate the orchestrator emits exactly one line on
stdout and aborts step 13 (no push, no PR, no merge):

```
! DOD-GATE FAILED: <gate> last status = <status or MISSING>; aborting before push.
```

Examples:

```
! DOD-GATE FAILED: review.task=3 last status = CHANGES_REQUIRED; aborting before push.
! DOD-GATE FAILED: static-check.task=2 last status = MISSING; aborting before push.
! DOD-GATE FAILED: visual-test last status = FAILED; aborting before push.
```

The orchestrator stops at the first failing gate; it does not enumerate
all failing gates. After escalation the feature stays on the branch in
its current state — the user can resume by addressing the named gate
(e.g. re-running the reviewer, completing the missing static-check).

## What dod-gate does not do

- It does **not** modify `feature.json` or any file.
- It does **not** dispatch any subagent.
- It does **not** consider the budget-warning line (see
  `dashboard-format.md`); the budget is informational only.
- It does **not** check for `[BLOCKED]` markers in the tasks file directly —
  if a task is blocked, its last history entry will not be in the pass
  set, so the gate fails for the right reason.

## Worked example (clean feature, all gates pass)

`feature.json.history` (abridged) for a 3-task feature with
`auto_tests: false`, `visual_tests: false`, all other end-gates
disabled:

```
spec                      DONE
plan                      DONE
implement task=1          DONE
implement task=2          DONE
implement task=3          DONE
static-check              PASSED
review                    APPROVED
```

Required gates: `spec`, `plan`, `implement.task=1..3`, `static-check`,
`review`. Every last entry is in the pass set → dod-gate PASSED →
orchestrator proceeds to lifecycle §1 step 13.

## Worked example (4-task feature, all gates enabled)

`feature.json` flags: `auto_tests: true`, `visual_tests: true`,
`a11y_audit: true`, `dependency_audit: true`, `security_review: true`.
Plan has 4 tasks. Implementers ran in two parallel groups (tasks 1+2,
then 3+4). All end-gates dispatched in parallel after implementers
finished.

`feature.json.history` (abridged):

```
spec                      DONE
plan                      DONE
implement task=1          DONE
implement task=2          DONE
implement task=3          DONE
implement task=4          DONE
static-check              PASSED
review                    APPROVED
auto-test                 PASSED
visual-test               PASSED
a11y                      PASSED
deps-audit                PASSED
security                  APPROVED
```

Required gates:

```
[ "spec", "plan",
  "implement.task=1", "implement.task=2",
  "implement.task=3", "implement.task=4",
  "static-check", "review",
  "auto-test", "visual-test",
  "a11y", "deps-audit", "security" ]
```

13 gates total. Every last entry is in `{ DONE, APPROVED, PASSED }` →
dod-gate PASSED → orchestrator proceeds to lifecycle §1 step 13 (single feature
commit + push + PR + merge).

## Worked example (lite run, 2 areas, no plan)

`track: "lite"`, `areas: [skills, dashboard]`, `auto_tests: false`,
`visual_tests: false`, other end-gates disabled. There is no plan.md.

```
spec                      DONE
implement.area=skills     DONE
implement.area=dashboard  DONE
static-check              PASSED
review                    APPROVED
```

Required gates: `spec`, `implement.area=skills`, `implement.area=dashboard`,
`static-check`, `review`. No `plan` gate. All pass → dod-gate PASSED.

## Worked example (quick run)

`track: "quick"`, no spec.md, no plan.md, all optional end-gates disabled.

```
implement                 DONE
static-check              PASSED
review                    APPROVED
```

Required gates: exactly `implement`, `static-check`, `review`. All pass →
dod-gate PASSED.

## Worked example (missing static-check)

Same 3-task feature, but the tree-wide `static-check` end-gate never
ran (e.g. orchestrator crashed before end-gate dispatch and resumed
past it):

```
! DOD-GATE FAILED: static-check last status = MISSING; aborting before push.
```

The orchestrator does not push, does not open a PR, does not merge.
User resumes by re-running `check --scope tree-wide --record`, then `dod` (`dev-cycle:cli-fallback` only as fallback).

## Worked example (separate_plan false)

`track: "full"`, `separate_plan: false`, spec.md has `## Tasks` with tasks 1-2, no plan.md.

```
spec                      DONE
implement task=1          DONE
implement task=2          DONE
static-check              PASSED
review                    APPROVED
```

Required gates: `spec`, `implement.task=1..2`, `static-check`, `review`. No `plan`
gate → PASSED. If spec.md had no `## Tasks`:
`! DOD-GATE FAILED: tasks last status = MISSING; aborting before push.`
With `separate_plan` absent, `plan` is still required (legacy).

## Worked example (bugfix with a stray track key)

`flow: "bugfix"`, `track: "full"`, `auto_tests: true`. Required gates:
`implement`, `static-check`, `review`, `auto-test`. No `spec`, no `plan`.
