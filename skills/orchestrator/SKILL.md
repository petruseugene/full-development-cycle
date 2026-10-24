---
name: orchestrator
description: End-to-end driver for any feature or bugfix. Runs the feature-start interview, dispatches every phase as a subagent, updates statuses, renders the dashboard, and produces a merged PR. Never writes feature code itself.
---

# Orchestrator

## When to use

- User says "build a feature", "fix a bug", "ship X", "implement Y end-to-end", or invokes `/orchestrator <description>`

NOT for: quick one-liner edits, pure research / Q&A, step-by-step pair-coding.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (the playbook core) first; `${CLAUDE_PLUGIN_ROOT}` is the plugin root on the `Plugin root:` line below.
   **Fast path:** flow `bugfix`, or flow `feature` on track `quick` (not escalated, no explicit lite/full; `visual_tests`, `a11y_audit`, `security_review`, `dependency_audit` all false): read only item 1 and `references/quick.md`. Track `polish` (small-issue list): item 1 + `references/polish.md`. Hotfix, escalation: full Required reading.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/references/lifecycle.md` (§1, §1a, Bugfix flow, §1c, §4, §5, §7, §9, §10). "Playbook §1/§1a/§4/§5/§7/§9/§10" here and in the references mean this file; §2/§3/§6/§8 mean the core.
3. `references/`: `dashboard-format.md`, `routing-edge-cases.md`, `dod-gate.md`, `parallel-groups.md`, `collision-and-fix-routing.md`; on demand `worktrees.md` (`worktrees.mode != off`), `release.md` (`ship --release`), `recipes.md` (profile recipes), `resume.md` (after compaction: `feature resume`)

Plugin root: `${CLAUDE_PLUGIN_ROOT}` — record this absolute value once at run start and use it as `<root>` in every dispatch prompt (subagent Reads don't expand it).

## State CLI

Every state change goes through the state CLI; never hand-edit `feature.json`, `plan.md` or `spec.md`. Resolve it **once** per session and reuse the absolute path:

```bash
CLI="${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs"
if [ -z "${CLAUDE_PLUGIN_ROOT}" ] || [ ! -f "$CLI" ]; then
  CLI=$(find ~/.claude/plugins -maxdepth 6 -type f -path '*dev-cycle*/scripts/dev-cycle.mjs' 2>/dev/null | head -1)
fi
node "$CLI" <command> [args] [--json] --feature <abs feature dir>
```

Pass `--feature <abs dir>` (except `feature init` / `init` / `profile`); auto-detection skips a closed feature for `check`/`recipe`/`gate` writes. Put `State CLI: node <abs path>` in every dispatch prompt. Exit `0` OK/PASSED, `1` FAILED, `2` usage error. Node ≥ 22.

| Command | Use |
|---|---|
| `init [--preset web\|expo] [--force]` | write `.dev-cycle/project.json` from `package.json` script names (runs nothing); exit 1 if it exists without `--force` |
| `profile show --json` / `profile validate` | read / check the profile (`exists: false` = none) |
| `feature init <slug> --flow <f> [--track <t>] [--answer k=v]...` | create the folder + `feature.json`, print the path. `--track` defaults to `quick`. Precedence `--answer` > profile > track defaults; the profile is snapshotted into `feature.json.profile` |
| `feature set <key> <value>` | one key (JSON-parsed if it parses, else string); allowlist in `lifecycle.md` (State CLI section): `current_phase`, `current_task_idx`, `task_count`, `branch`, `status`, `areas`, `models`, `design_source`, `owner_blocking`; others exit 2 |
| `groups --json [--all]` | runnable parallel groups from the tasks file (plan.md, or spec.md `## Tasks` when `separate_plan=false`) |
| `brief <n>` | write `briefs/task-<n>.md` (full track; has `**Model:**`, lessons, threat notes, recipe) |
| `task <n> status <S>` · `task --all-from IMPL-DONE --to DONE` · `spec status <S>` · `spec decisions [--json]` (read-only) | status flips (`TODO`, `IN PROGRESS`, `IMPL-DONE`, `IN REVIEW`, `BLOCKED`, `DONE`) |
| `history add --phase <p> --subagent <s> --status <st> [--model m] [--duration d] [--tokens t] [--agent-id <id>] [--summary s] [--concerns c]` | append an entry (`--help` lists phases); `--agent-id` reads measured tokens from the transcript (`--tokens` is the fallback); `totals` are recomputed |
| `check [--scope touched\|tree-wide] [--files a,b]... [--steps lint,typecheck,format,test] [--record]` | lint / typecheck / format (/ test) without an agent. Exit `0` PASSED, `1` FAILED, `2` no commands. Test output is quiet: failing tests only, classified touched vs elsewhere; a non-zero test run is never PASSED. `--record` writes the `static-check` entry; a FAILED tree-wide run writes `static-check-report.md` |
| `review snapshot [--cycle n]` · `review diff [--since-cycle n] [--name-only]` | snapshot the tree before a reviewer dispatch / print the incremental diff (exit 2 with no snapshot) |
| `ship [--release major\|minor\|patch\|auto] [--subject s] [--body b] [--notes-file f] [--manifest path]... [--ci-timeout s] [--gh-credential]` | tokens → dod → release bump + CHANGELOG → commit → push → PR → merge → tag; re-run skips done steps; main session only (`references/release.md`) |
| `git branch [<name>]` · `git commit [--subject s] [--body b] [--scope s] [--trailer "K: v"]... [--closes n,m]` · `git push` · `git pr [--base b] [--title t] [--body-footer text]` · `git merge [--ci-timeout s]` | individual verbs (partial runs, hotfix `--base`); `commit` flips statuses in one commit, `merge` runs `dod` first. Network verbs take `--gh-credential` (or `DEV_CYCLE_GIT_CREDENTIAL=gh`; fixes the osxkeychain hang). Failures exit `1`: `git <verb>: FAILED <reason> — <detail>` |
| `tokens agent <id>` · `tokens orchestrator` | measured usage (read-only) / upsert the orchestrator entry |
| `gate run <name>\|--all` · `post-merge run <name>\|--all [--confirmed]` | `profile.extra_gates` (records `gate.<name>`) / `profile.post_merge` |
| `dod` | read-only DoD gate (exit 0 PASSED / 1 FAILED) |
| `lessons add --globs <g,..> --text <rule> [--ref r]` · `lessons list [--touches g,..] [--json]` · `lessons prune --id L3[,L5] \| --before YYYY-MM-DD \| --keep N` | `.dev-cycle/lessons.md` (prune is manual, one selector) |
| `recipe run <name> [--param k=v]... [--task <n>] [--timeout <s>]` · `recipe list [--json]` | the only way to run a profile recipe (argv, no shell; grammar: `references/recipes.md`) |
| `worktree start\|collect\|remove --all\|list` | opt-in isolation: `references/worktrees.md` |
| `visual …` · `report --feature <f>` | visual-tester CLI (`visual teardown` below) / render the report index and print its path |

`dev-cycle:cli-fallback` (replacing static-checker and git-agent) is dispatched only for the failures named below. A PreToolUse hook (`scripts/git-guard.mjs`) denies state-changing git from subagents.

## The job

1. **Feature-start interview** — `profile show --json`, then the questions in `lifecycle.md` §4. **Track is never asked.** For flow `feature` start at `quick` (the default) and escalate without asking, printing exactly one line `> TRACK: <track> — <reason>` before any dispatch; an explicit user track wins.
   - `lite`: the request spans more than one area, or adds a new screen or a new API;
   - `full`: it spans several subsystems, has architecture impact, or needs wireframes for new UI.

   `lite` skips discovery depth; `quick` asks nothing more (inference: `references/quick.md`). `--track` only for flow `feature`; bugfix and hotfix use the quick gate set (`references/dod-gate.md`).

   **Separate plan.** For a medium `full` feature you may pass `--answer separate_plan=false` (tasks in spec.md, no plan-writer) and emit `> PLAN: tasks in spec — <reason>`; never ask.

   **Profile defaults.** Questions the profile answers are not asked; show them as `> defaults (project profile): platform=web, auto_tests=true, … OK?` and treat any correction as an answer. An invalid profile exits `2`: surface it.

   Then `feature init <slug> --flow <flow> [--track <t>] --answer <key>=<value>`, one `--answer` for **every** interview value you decided (asked, inferred or corrected; omit only profile/track defaults). Slug kebab-case ≤40. User model overrides: `feature set models '<json>'`.

2. **Dispatch each phase** as a subagent via the `Agent` tool per `lifecycle.md` §1. Per-task phases run in parallel groups (one group at a time); end-of-feature phases run once, as one parallel fan-in, after every task is `[IMPL-DONE]`.

   | Phase | Subagent | Trigger |
   |---|---|---|
   | Discovery | `dev-cycle:discovery` | `discovery != "skip"` (`internal` = Internal mode only; defaults: `lifecycle.md` §5) |
   | Architecture | `dev-cycle:architector` | `overview.md` missing OR "architecturally significant" |
   | Spec | `dev-cycle:spec-writer` | `track != "quick"`; lite/full then `references/open-decisions.md` |
   | Wireframes | `dev-cycle:wireframer` | `track == "full"` and `design_source` null |
   | Plan | `dev-cycle:plan-writer` | `track == "full"` and `separate_plan != false` (`task_count` from the tasks source) |
   | Implement | `dev-cycle:frontend-dev` / `dev-cycle:backend-dev` | per task tag (`mixed` → frontend-dev, or backend-dev when frontend-dev is in `skipped_skills`), parallel within each disjoint group |
   | Implement (content) | `content → dev-cycle:backend-dev` | tag `content`, any stack token; brief has `## Recipe`; grouped like any non-owner task; dod needs `implement.task=<n>` |
   | Owner step | `owner → none (wait for owner)` | tag `owner`; never dispatched |
   | Implement (lite / quick) | frontend-dev / backend-dev | lite: one per `areas` entry (`feature set areas` first; disjoint `touches` parallel, overlaps serialized); quick: one (`references/quick.md`) |
   | Static check | `check --scope touched` (implementer, before DONE); `check --scope tree-wide --record` (you) | tree-wide unless `static_check == false`; `dev-cycle:cli-fallback` only on exit 2 or a failure surviving a fix cycle (prompt carries `check`'s output) |
   | Review | `dev-cycle:code-reviewer` | always; `review snapshot` right before each dispatch |
   | Auto-tests | `dev-cycle:auto-tester` | `auto_tests == true` |
   | Visual tests | `dev-cycle:visual-tester` | `visual_tests`, or a11y-only when `a11y_audit && has_ui` |
   | Security | `dev-cycle:security-reviewer` | `security_review`, or dependency-audit-only when `dependency_audit` |
   | Extra gates / DoD / Ship | `gate run --all`, `dod`, `ship` | non-empty `profile.extra_gates`; before push; after dod passes |

   **Review cycles.** Cycle 1 reviews the whole-feature diff; cycles 2–3 get the `review diff --since-cycle <previous>` output reference plus the previous findings, not the whole diff. Pass the feature-level cycle number (1–3).

   **Visual tests teardown (mandatory fallback).** When the Visual tests gate returns (any status, even interrupted) and `verification/teardown.json` is missing or older than the manifest's `last_activity`, run `node <CLI> visual teardown --feature <f>` before routing. It stops only recorded devices and verified process groups, never the Playwright browser.

   **Report.** After each end-gate round run `report --feature <f>` and print the path. Profile command logs (`gates/`, `post-merge/`, `content/`) are committed: warn if one might print secrets.

   **Ship.** After dod run `ship` (replaces commit → push → pr → merge). With `release_manage == true` pass `--release auto` unless the user named a level, notes per `references/release.md`. `dev-cycle:cli-fallback` (git mode) only for `conflict`, `not-mergeable`, `push-rejected`, `hook-failed` needing a code fix (implementer fix loop first) and the hotfix cherry-pick; other reasons go to the user in one line (`lifecycle.md` §7).

   **Skipped skills.** Never dispatch a skill in `feature.json.skipped_skills`: emit `> SKIP: <skill> — not in enabled_skills` and continue (`lifecycle.md` §10).

   **Phase boundaries.** Entering a phase: `feature set current_phase <phase>`; `task_count <n>` once the tasks file exists.

   **Owner tasks.** An `owner` task is a manual owner step, never dispatched (`groups`, `task --all-from`, `git commit` skip it). At every phase boundary while one is not `DONE`, and right before `dod`, print per open task `> OWNER: Task <n> — <title> (waiting)` (`references/dashboard-format.md`). Run `task <n> status DONE` only after the user explicitly confirms that task in the conversation; never infer it from files, history or silence. Only `owner_blocking: true` makes dod require `owner.task=<n>`.

   **Parallel groups.** One message of N `Agent` calls per group ("Dispatch pattern", `references/parallel-groups.md`); wait for all reports before the next group; same fan-out for end-gates. Groups are recomputed every iteration (tiers by `Depends on`, batches of disjoint `Touches`); `## Execution plan` is documentation only.

   **Model on every dispatch.** Every `Agent` call (all flows) passes `model: <resolved>` (omitted for `inherit`). Resolve per `lifecycle.md` §10 "Model resolution" (the five rules, first match wins; no Size-based escalation); on an invalid override emit `! MODEL: ignoring invalid override <skill>=<value>`.

   **Dispatch prompt** for every subagent:
   - The skill file (`<root>` the recorded plugin root, `<x>` the skill directory): "Read `<root>/skills/<x>/SKILL.md` and follow it. `${CLAUDE_PLUGIN_ROOT}` means `<root>`; `references/…` paths are relative to `<root>/skills/<x>/`. Do not call the Skill tool for dev-cycle skills." Fallback and nested dispatches use it too.
   - Absolute feature folder, State CLI path, the reminder to end with the YAML report (playbook core §6), and the resolved model of any nested skill it may dispatch.
   - **Full-track implementers:** run `brief <n>` before each dispatch (re-dispatches too); pass `<feature>/briefs/task-<n>.md` as the primary input plus `auto_tests`, `platform`, `design_source`, `has_ui`, not `feature.json` or a tasks slice. With a `**Wireframes:**` field add a `Wireframes (binding contract):` header listing every path absolute under the feature folder, plus: "Open every listed wireframe before writing code; the page must match each wireframe's visible structure column-for-column / element-for-element. Any AC anchored to one of these files is binding — a missing column is a review failure."
   - **Lite (quick: `references/quick.md`):** current `feature.json`, `Area: <name>`, `Touches: <globs>`, the spec.md AC ids the area owns.
   - **Lessons (lite and quick only; no brief).** Before each dispatch run `context --touches "<globs>"` (lite: the area's `touches`) and, only when non-empty, append the output verbatim (no second `Lessons (advisory):` header). Briefs carry `## Lessons` and `## Project map`.
   - **Threat notes (lite).** When spec.md has `## Threat notes`, append that section verbatim to the implementer prompt, as with lessons. Briefs copy it; reviewers read it.
   - All other subagents: the current `feature.json`.

3. **Read only the YAML report** each subagent returns, never the long output files. Record it: `history add --phase <p> --subagent <skill> --status <status> --model <resolved|inherit> --duration "<duration>" --tokens "<tokens_used>"` (fallback) plus `--agent-id <agentId>` (from the launch result or task-notification) on **every** subagent entry, and `--concerns` when present. Implementers also get `--summary "<one-line summary>"` (the dependency summary in `brief`). Phase keys: `implement.task=<n>` (full), `implement.area=<name>` (lite), `implement` (quick).

4. **Route per `lifecycle.md` §7** plus the parallel rules below. On `CHANGES_REQUIRED` / `FAILED` re-dispatch the implementer with the artefact path; after 3 cycles `[BLOCKED]` and escalate. `full` routes by `## Task N` sections, `lite` by `## Area <name>` (3-cycle limit per area), `quick` per `references/quick.md`.

   - **Sibling collision.** Compare members' `touches_expanded` plus declared `Touches` pairwise; on a shared written path log `history add --phase conflict` and reschedule the **later** task (plan order) **serially next cycle** (counts against its 3-cycle limit).
   - **Cross-cutting findings** (`## Cross-cutting`, or non-attributable) go to the task whose `Touches` most overlap (lite: area `touches`); none: **escalate with the finding text**, never guess.
   - **`NEEDS_CONTEXT` in a group:** let the group finish, then re-dispatch that task **serially next iteration** with the context.
   - **Only-failed-gates re-run** after a fix cycle (dod reads the last status per gate).

5. **Statuses** only through the CLI (`task <n> status "<S>"`, `spec status <S>`); the IMPL-DONE→DONE and spec DONE flips happen inside the feature commit. Task rules are `full` only; `lite` flips spec.md, `quick` nothing.
   - Implementer `DONE` → `[IMPL-DONE]`, **not** `[DONE]` (reserved for the feature commit). Fix-cycle findings → `[IN REVIEW]` while the implementer re-runs, then back to `[IMPL-DONE]`; `[IN PROGRESS]` while one runs; `[BLOCKED]` on 3-cycle exhaustion or unresolvable collision.
   - A pre-task phase reporting `BLOCKED`: `feature set status blocked` and escalate; `feature set status active` on resume.

6. **Dashboard** between phases and on demand (`references/dashboard-format.md`).

7. **DoD gate.** Once every task is `[IMPL-DONE]` and the end-gates (incl. `gate run --all`) are done, run `dod` **before** pushing. Exit `1` prints `! DOD-GATE FAILED: <gate> last status = <status or MISSING>; aborting before push.`: emit it and abort (no push, PR or merge). Gates: `references/dod-gate.md`.

   **Post-merge.** If `profile.post_merge` is non-empty, list the steps and ask the owner; only on an explicit yes run `post-merge run --all --confirmed`, else note the skipped steps in the final report.

8. **Budget warning** on every dashboard render: defaults `{usd: 50, time_s: 7200}` unless `feature.json.budget` is set; if `usd_est` (only with `measured_entries > 0`), `tokens_k` or `time_s` is over, emit exactly one `! BUDGET: <reasons>; budget <k>=<v>…` line (keys in effect), else nothing. It never aborts, re-dispatches or blocks dod. Rules and scenarios: `references/dashboard-format.md`.

9. **Final report** — `node <CLI> report --feature <f>` path; totals (`totals.measured`, labelled an estimate), branch, commit SHA(s) (one per run; polish: one per item), PR URL, merge confirmation. List every owner step (`Task <n> — <title>`, status): always in `lite`, in `full` when owner tasks exist. Append `## Follow-ups` when pending.

## Output contract

No YAML block (top-level skill); the final-report message is:

```
Feature complete: <slug>
PR: <url>  (merged at <ts>)
Tasks: 12/12 done
Time: 28m 47s
Tokens (estimate, measured): 38.4k billable, ~$12.40
Branch deleted: feat/<slug>
```

If BLOCKED:

```
ESCALATED: <slug>
Blocked task: Task N — <name>
Blocker: <text>
Recovery hints: <bullets>
```
