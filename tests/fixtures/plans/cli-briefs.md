---
feature: project-profile-state-cli-briefs
spec: ./spec.md
status: [TODO]
---

# Project profile, state CLI, per-task briefs — Plan

## Tasks
- [IMPL-DONE] **Task 1** (backend): CLI foundation — entry, router, core I/O, feature.json + totals
- [IN PROGRESS] **Task 2** (backend): plan/spec parser and status commands (`task`, `spec status`)
- [IN PROGRESS] **Task 3** (backend): `history add` and `dod`
- [IN PROGRESS] **Task 4** (backend): project profile (`profile validate|show`) and `feature init`
- [IN PROGRESS] **Task 5** (backend): command runner — `gate run` and `post-merge run`
- [TODO] **Task 6** (backend): `groups` — topo tiers + conservative glob overlap
- [TODO] **Task 7** (backend): `brief <n>` + no-profile end-to-end test
- [TODO] **Task 8** (backend): playbook rewiring to the CLI + profile
- [TODO] **Task 9** (backend): orchestrator SKILL.md + `commands/orchestrator.md` rewiring
- [TODO] **Task 10** (backend): orchestrator references rewiring
- [TODO] **Task 11** (backend): implementer skills read briefs; static-checker commands preference
- [IMPL-DONE] **Task 12** (frontend): dashboard parses `[IMPL-DONE]` / `[IN REVIEW]`

## Execution plan
- Group 1 (parallel): Task 1, Task 12          — CLI foundation; dashboard fix is independent
- Group 2 (parallel): Task 2, Task 3, Task 4, Task 5   — disjoint CLI modules on top of Task 1
- Group 3 (serial):   Task 6                   — needs the plan parser (Task 2)
- Group 4 (serial):   Task 7                   — needs parser + overlap (Tasks 2, 6) and all commands for the e2e test
- Group 5 (parallel): Task 8, Task 9, Task 10, Task 11 — skill text, disjoint file sets, documents the finished CLI surface

## Task details

### Task 1: CLI foundation — entry, router, core I/O, feature.json + totals  `[IMPL-DONE]`
**Tag:** backend
**Touches:** `scripts/dev-cycle.mjs`, `scripts/lib/core.mjs`, `scripts/lib/feature-json.mjs`, `scripts/lib/totals.mjs`, `scripts/test/helpers.mjs`, `scripts/test/core.test.mjs`, `scripts/test/feature-json.test.mjs`, `scripts/test/totals.test.mjs`
**Depends on:** none
**Size:** L
**Files:** `scripts/dev-cycle.mjs` (new), `scripts/lib/core.mjs` (new), `scripts/lib/feature-json.mjs` (new), `scripts/lib/totals.mjs` (new), `scripts/test/helpers.mjs` (new)
**Acceptance:** AC1, AC2, AC3, AC4, AC10
**Steps:**
- [ ] `scripts/dev-cycle.mjs`: `#!/usr/bin/env node`, ESM, Node ≥ 22 check. Holds the full command table for every command in R5–R16 (`feature`, `task`, `spec`, `history`, `groups`, `dod`, `gate`, `post-merge`, `profile`, `brief`) mapping each to `./lib/cmd-<name>.mjs`, loaded by dynamic `import()`. Each module exports `run(argv, ctx)`. Unknown command → exit 2. Later tasks only add their `cmd-*.mjs`; they never edit this file.
- [ ] `core.mjs`: `UsageError` (exit 2) / `FailedError` (exit 1); `parseArgs` wrapper (`node:util`, `strict: true`) so unknown flags and missing args exit 2 with a stderr message; output helper (one-liner vs single JSON doc with `--json`); feature-dir resolution per R3 (`--feature` > `DEV_CYCLE_FEATURE` > lexicographically newest `docs/features/*`); project-root resolution; `atomicWrite(path, text)` (dot-prefixed temp in same dir + `rename`, re-read target immediately before write); text read helper.
- [ ] `feature-json.mjs`: `readFeatureJson` / `updateFeatureJson(dir, mutator)` — re-reads, applies mutator, replaces `totals` with `computeTotals(history)`, writes atomically with 2-space JSON; unknown keys preserved deep-equal.
- [ ] `totals.mjs`: pure `computeTotals(history)` per R10 (`by_subagent` calls excluding `interview`/`conflict`/`gate.*`; approved = APPROVED|PASSED; retried = CHANGES_REQUIRED|FAILED|NEEDS_CONTEXT; sums; `by_model` with `unknown`).
- [ ] `scripts/test/helpers.mjs`: `mkFixture()` (mkdtemp project root with `docs/features/<dir>`), `runCli(args, {cwd, env})` via `spawnSync(process.execPath, …)`.
- [ ] Tests: AC2 (unknown command / flag / missing arg → 2 + stderr), AC3 (three resolution cases), AC4 (unknown keys deep-equal, no leftover temp), AC10 (hand-computed totals fixture, idempotent), AC1 (test walks `scripts/**/*.mjs` imports: only `node:` or relative; no `package.json` with deps under `scripts/`).

### Task 2: plan/spec parser and status commands  `[IN PROGRESS]`
**Tag:** backend
**Touches:** `scripts/lib/plan.mjs`, `scripts/lib/cmd-task.mjs`, `scripts/lib/cmd-spec.mjs`, `scripts/test/plan.test.mjs`, `scripts/test/status.test.mjs`, `scripts/test/fixtures/plans/**`
**Depends on:** Task 1
**Size:** M
**Files:** `scripts/lib/plan.mjs` (new), `scripts/lib/cmd-task.mjs` (new), `scripts/lib/cmd-spec.mjs` (new)
**Acceptance:** AC5, AC6, AC7, AC8
**Steps:**
- [ ] `plan.mjs`: tolerant reader returning tasks `{n, tag, status, title, listLineIdx, headingIdx?, detailText?, touches[], dependsOn[], files[], wireframes[], acceptanceRaw, size}`. Tolerates one/two spaces before the heading marker, trailing `(tag)` on headings, `Depends on` forms `none…` / `Task 1` / `Task 1, Task 2`, missing detail sections. Exports `setTaskStatus(text, n, S)` touching only task n's list line and heading, and status normalisation (`IN-PROGRESS`→`IN PROGRESS`, `IN-REVIEW`→`IN REVIEW`). This parser is reused by Tasks 6 and 7.
- [ ] `cmd-task.mjs`: `task <n> status <S>` (unknown n or S → 2, file unchanged); `task --all-from IMPL-DONE --to DONE` skipping `owner` tag and `[BLOCKED]`, prints changed numbers; any other pair → 2.
- [ ] `cmd-spec.mjs`: `spec status <S>` rewrites the first `status:` line inside the first `---` block of spec.md; on DONE also plan.md frontmatter `status:`.
- [ ] Fixtures copied/adapted from 3–4 real `docs/features/*/plan.md`; byte-diff tests for AC5–AC8.

### Task 3: `history add` and `dod`  `[IN PROGRESS]`
**Tag:** backend
**Touches:** `scripts/lib/history.mjs`, `scripts/lib/cmd-history.mjs`, `scripts/lib/dod.mjs`, `scripts/lib/cmd-dod.mjs`, `scripts/test/history.test.mjs`, `scripts/test/dod.test.mjs`
**Depends on:** Task 1
**Size:** M
**Files:** `scripts/lib/history.mjs`, `scripts/lib/cmd-history.mjs`, `scripts/lib/dod.mjs`, `scripts/lib/cmd-dod.mjs` (all new); reference: `skills/orchestrator/references/dod-gate.md`
**Acceptance:** AC9, AC14, AC15
**Steps:**
- [ ] `history.mjs`: closed phase grammar (R9), `parseDuration` (`52`, `52s`, `2m 14s`), `parseTokens` (`3.2`, `3.2k`, `~3.2k`), `appendHistory(dir, entry)` via `updateFeatureJson`. Export `appendHistory` for reuse by Task 5.
- [ ] `cmd-history.mjs`: `history add --phase --subagent --status [--model inherit] [--duration] [--tokens] [--summary] [--concerns]`; ISO `ts`; invalid phase → 2, nothing appended.
- [ ] `dod.mjs` / `cmd-dod.mjs`: required set exactly as in dod-gate.md (derived from feature.json flags) plus `gate.<name>` per `profile.extra_gates`; last-status pass rule; exact `DOD-GATE PASSED` / `! DOD-GATE FAILED: <gate> last status = <status|MISSING>; aborting before push.` lines; exit 0/1.
- [ ] Tests for AC9, AC14, AC15 (including no-`profile` ⇒ required set equals dod-gate.md formula).

### Task 4: project profile and `feature init`  `[IN PROGRESS]`
**Tag:** backend
**Touches:** `scripts/lib/profile.mjs`, `scripts/lib/cmd-profile.mjs`, `scripts/lib/cmd-feature.mjs`, `scripts/test/profile.test.mjs`, `scripts/test/feature-init.test.mjs`
**Depends on:** Task 1
**Size:** M
**Files:** `scripts/lib/profile.mjs`, `scripts/lib/cmd-profile.mjs`, `scripts/lib/cmd-feature.mjs` (all new)
**Acceptance:** AC16, AC17
**Steps:**
- [ ] `profile.mjs`: load `<root>/.dev-cycle/project.json` (missing ⇒ valid empty); allowlist validation per R15 (types, duplicate names, `[a-z0-9-]+` names, `enabled_skills` against registry skill names); unknown top-level key ⇒ stderr warning only.
- [ ] `cmd-profile.mjs`: `profile validate`, `profile show [--json]`.
- [ ] `cmd-feature.mjs`: `feature init <slug> --flow --track [--answer k=v]…`; folder `docs/features/<YYYY-MM-DD-HHh-MMm>-<slug>/`; precedence `--answer` > profile `interview_defaults` / `platform` > track defaults (playbook §5 discovery default by track); copies `commands`, `extra_gates`, `post_merge`, `guards`, `rules`, `enabled_skills` into `feature.json.profile` only when a profile exists; prints the folder path.
- [ ] Tests for AC16, AC17.

### Task 5: command runner — `gate run` and `post-merge run`  `[IN PROGRESS]`
**Tag:** backend
**Touches:** `scripts/lib/runner.mjs`, `scripts/lib/cmd-gate.mjs`, `scripts/lib/cmd-post-merge.mjs`, `scripts/test/runner.test.mjs`
**Depends on:** Task 1
**Size:** M
**Files:** `scripts/lib/runner.mjs`, `scripts/lib/cmd-gate.mjs`, `scripts/lib/cmd-post-merge.mjs` (all new)
**Acceptance:** AC18, AC19, AC20
**Steps:**
- [ ] `runner.mjs`: `runStep({cmd, timeout_s=600, logPath, featureDir, root})` — echo command, `spawn(cmd, {shell: true, cwd: root, detached: true, env: {...process.env, DEV_CYCLE_FEATURE_DIR}})`, combined output to log, kill process group (`process.kill(-pid)`) on timeout; returns PASSED|FAILED. The command string passed to `spawn` is the profile string verbatim (unit-tested).
- [ ] `cmd-gate.mjs`: `gate run <name>|--all` from `feature.json.profile.extra_gates`, logs `gates/<name>.log`, appends history `{phase: gate.<name>, subagent: gate, status}` (write via `updateFeatureJson` from Task 1; do not import Task 3's module so Tasks 3 and 5 stay independent); no extra gates ⇒ prints "no extra gates", no history entry, exit 0; any failure ⇒ exit 1.
- [ ] `cmd-post-merge.mjs`: `post-merge run <name>|--all [--confirmed]`, logs in `post-merge/<name>.log`; `confirm: true` without `--confirmed` prints the exact command, runs nothing for it, exits 1.
- [ ] Tests for AC18 (exit 0 / exit 3 / `sleep 5` with `timeout_s: 1` killed within 3 s), AC19, AC20 (marker file).

### Task 6: `groups` — topo tiers + conservative glob overlap  `[TODO]`
**Tag:** backend
**Touches:** `scripts/lib/groups.mjs`, `scripts/lib/glob-overlap.mjs`, `scripts/lib/cmd-groups.mjs`, `scripts/test/groups.test.mjs`
**Depends on:** Task 1, Task 2
**Size:** M
**Files:** `scripts/lib/glob-overlap.mjs`, `scripts/lib/groups.mjs`, `scripts/lib/cmd-groups.mjs` (all new); reference: `skills/orchestrator/references/parallel-groups.md`
**Acceptance:** AC11, AC12, AC13
**Steps:**
- [ ] `glob-overlap.mjs`: `globsOverlap(a, b)` — literal-prefix comparison up to the first wildcard segment, then `path.matchesGlob` both ways, undecidable ⇒ overlapping. Exported for Task 7.
- [ ] `groups.mjs`: topo tiers from `Depends on` (cycle or missing dep ⇒ exit 2), then greedy disjoint batches in plan order; task without Touches ⇒ singleton group; without `--all` exclude IMPL-DONE/DONE/BLOCKED/`owner`, treat IMPL-DONE/DONE deps as satisfied.
- [ ] `cmd-groups.mjs`: `groups [--all] [--json]` (JSON = array of arrays of task numbers).
- [ ] Tests: parallel-groups.md five-task example ⇒ `[[1,2],[3,4],[5]]`, variant ⇒ `[[1,2],[3],[4],[5]]`; AC12; AC13.

### Task 7: `brief <n>` + no-profile end-to-end test  `[TODO]`
**Tag:** backend
**Touches:** `scripts/lib/brief.mjs`, `scripts/lib/cmd-brief.mjs`, `scripts/test/brief.test.mjs`, `scripts/test/no-profile.test.mjs`, `scripts/test/fixtures/brief/**`
**Depends on:** Task 2, Task 3, Task 4, Task 5, Task 6
**Size:** M
**Files:** `scripts/lib/brief.mjs`, `scripts/lib/cmd-brief.mjs` (new)
**Acceptance:** AC21, AC22, AC29
**Steps:**
- [ ] `brief.mjs`: full-track only (else exit 2); sections in R16 order — Task (detail section verbatim), Acceptance criteria (ids + `ACa–ACb` / `ACa-ACb` ranges resolved from spec §6 and the Wireframe AC section; none parse ⇒ block verbatim; unresolved id ⇒ exit 2), Touches, Depends on (last `implement.task=<d>` `summary` or `(no summary recorded)`), Project rules (`profile.guards` + `profile.rules` whose globs overlap Touches via `globsOverlap`), empty Lessons heading, Files to read (`**Files:**` / `**Wireframes:**` entries suffixed with the field name). Never opens `CLAUDE.md`.
- [ ] `cmd-brief.mjs`: writes `<feature>/briefs/task-<n>.md` atomically, prints path.
- [ ] Tests for AC21, AC22 (including a grep of `scripts/lib` for `CLAUDE.md` returning nothing).
- [ ] `no-profile.test.mjs` (AC29, CLI part): project without `.dev-cycle/` through `feature init`, `dod`, `groups`, `gate run --all` — no `profile` key, dod required set equals dod-gate.md formula, "no extra gates", no history entry, exit 0.

### Task 8: playbook rewiring to the CLI + profile  `[TODO]`
**Tag:** backend
**Touches:** `skills/playbook/SKILL.md`
**Depends on:** Task 7
**Size:** M
**Files:** `skills/playbook/SKILL.md`
**Acceptance:** AC23, AC25, AC28, AC29
**Steps:**
- [ ] §1 steps 7, 8a/8c, 10, 12, 13: name `groups`, `task <n> status`, `history add`, `dod`, `task --all-from IMPL-DONE --to DONE`, `spec status DONE` as the way state changes; step 9 adds `gate run --all` when `profile.extra_gates` exist; post-merge via `post-merge run` after owner confirmation.
- [ ] §2: plan.md/spec.md status flips and feature.json are written by the CLI (`scripts/dev-cycle.mjs`); add `briefs/task-<n>.md`, `gates/*.log`, `post-merge/*.log` rows.
- [ ] §4: profile-answered questions are not asked; one "defaults from profile: … OK?" line; no profile ⇒ interview unchanged.
- [ ] §5: optional `profile` key; `.dev-cycle/project.json` shape (R15); "History keys" now says totals are recomputed from history by the CLI (remove incremental "adds 1" wording); explicit "absent profile ⇒ current behaviour".
- [ ] §8: orchestrator never hand-edits status/history/totals; it calls the CLI.
- [ ] Use `${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs`, never `/Users/`; `bash scripts/lint-skills.sh` passes.

### Task 9: orchestrator SKILL.md + `commands/orchestrator.md` rewiring  `[TODO]`
**Tag:** backend
**Touches:** `skills/orchestrator/SKILL.md`, `commands/orchestrator.md`
**Depends on:** Task 7
**Size:** L
**Files:** `skills/orchestrator/SKILL.md`, `commands/orchestrator.md`; reference: `commands/dashboard.md` (fallback pattern)
**Acceptance:** AC23, AC24, AC25, AC26, AC28
**Steps:**
- [ ] Add a "State CLI" preamble: resolve once `node "${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs"`, else the `find ~/.claude/plugins` fallback from `commands/dashboard.md`; always pass `--feature <dir>`; pass the resolved absolute CLI path in subagent dispatch prompts.
- [ ] Step 1 interview: `profile show --json` first; skip profile-answered questions, one "defaults … OK?" line; no profile ⇒ unchanged; then `feature init`.
- [ ] Step 2: groups from `groups --json`; full-track implementer dispatch list = skill name, feature folder, brief path (generated via `brief <n>`), CLI path, `auto_tests` / `platform` / `design_source` / `has_ui`, YAML reminder, nested models, wireframes — no full feature.json, no plan.md slice. Lite/quick dispatch unchanged. End-of-feature table adds `gate run --all` when `profile.extra_gates` exist; warn that `gates/` and `post-merge/` logs are committed so commands must not print secrets.
- [ ] Step 3: `history add` replaces incremental totals updates.
- [ ] Step 5 (line ~107): replace single-line `Edit` instruction with `task <n> status`, `spec status`, `task --all-from IMPL-DONE --to DONE`.
- [ ] Step 7: `dod` replaces the inline pseudo-code (keep a pointer to dod-gate.md); after merge, `post-merge run --all --confirmed` only after explicit owner yes.
- [ ] `commands/orchestrator.md`: mention the CLI owns state changes.
- [ ] `bash scripts/lint-skills.sh` passes; the AC23 grep returns nothing.

### Task 10: orchestrator references rewiring  `[TODO]`
**Tag:** backend
**Touches:** `skills/orchestrator/references/dod-gate.md`, `skills/orchestrator/references/parallel-groups.md`, `skills/orchestrator/references/routing-edge-cases.md`, `skills/orchestrator/references/collision-and-fix-routing.md`, `skills/orchestrator/references/dashboard-format.md`
**Depends on:** Task 7
**Size:** M
**Files:** the five reference files above
**Acceptance:** AC23, AC28
**Steps:**
- [ ] `dod-gate.md`: the rule is executed by `dev-cycle.mjs dod`; required set gains `gate.<name>` per `profile.extra_gates`; escalation line unchanged.
- [ ] `parallel-groups.md`: `groups` computes the partition; replace `git ls-files | grep -E` expansion with the conservative prefix + `matchesGlob` overlap rule; tasks without Touches run alone; `owner` tasks excluded.
- [ ] `routing-edge-cases.md`, `collision-and-fix-routing.md`: `[BLOCKED]` / `[IN PROGRESS]` / `[IN REVIEW]` flips via `task <n> status`; conflict entries via `history add --phase conflict`; extra-gate failures route by file paths in `gates/<name>.log`, else escalate.
- [ ] `dashboard-format.md`: note `totals` is recomputed by the CLI (only if wording implies hand updates).
- [ ] Each of the four AC23 references mentions `dev-cycle.mjs`; lint passes.

### Task 11: implementer skills read briefs; static-checker commands preference  `[TODO]`
**Tag:** backend
**Touches:** `skills/frontend-dev/SKILL.md`, `skills/backend-dev/SKILL.md`, `skills/static-checker/references/stack-detection.md`
**Depends on:** Task 7
**Size:** S
**Files:** `skills/frontend-dev/SKILL.md`, `skills/backend-dev/SKILL.md`, `skills/static-checker/references/stack-detection.md`
**Acceptance:** AC26, AC27, AC28
**Steps:**
- [ ] frontend-dev / backend-dev Required reading: full track ⇒ `briefs/task-<n>.md` instead of the plan.md slice; must not read `spec.md` or `plan.md` in full; return `NEEDS_CONTEXT` naming the missing information when the brief is insufficient. Lite/quick wording unchanged. Implementer test/lint step prefers `.dev-cycle/project.json` `commands` when present.
- [ ] `stack-detection.md`: profile `commands.{lint,typecheck,format}` take precedence over detected tools. Do not touch `skills/static-checker/SKILL.md` (58/60 lines).
- [ ] `wc -l skills/static-checker/SKILL.md` ≤ 60; lint passes.

### Task 12: dashboard parses `[IMPL-DONE]` / `[IN REVIEW]`  `[IMPL-DONE]`
**Tag:** frontend
**Touches:** `dashboard/lib/parsers.ts`, `dashboard/lib/types.ts`, `dashboard/app/api/features/[id]/tasks/route.ts`, `dashboard/lib/__tests__/parsers-impl-done.test.ts`
**Depends on:** none
**Size:** S
**Files:** `dashboard/lib/parsers.ts`, `dashboard/app/api/features/[id]/tasks/route.ts`, `dashboard/lib/__tests__/parsers-impl-done.test.ts` (new); `dashboard/lib/types.ts` only if the status union needs it
**Acceptance:** AC30
**Steps:**
- [ ] Add `IMPL-DONE` and `IN REVIEW` to the list-line and detail-heading regexes and `STATUS_MAP`, both mapping to `IN_TESTING` (no new board column).
- [ ] `STRICT_TASK_LINE_RE` in the tasks route accepts both statuses.
- [ ] Vitest: new list lines parse to `IN_TESTING`; existing statuses unchanged; "+ Task" next number after them is 3. `cd dashboard && npm test` and `npx tsc --noEmit` pass (no lint config — skip lint).
