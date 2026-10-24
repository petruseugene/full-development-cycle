# Playbook — lifecycle (orchestrator only)

The orchestrator-only half of the playbook; the core (`../SKILL.md`: §2, §3, §6, §8) applies too, and section numbers match it. Home of the flows, schema, routing and registry. The State CLI command table lives in `../../orchestrator/SKILL.md`, the recipe grammar in `../../orchestrator/references/recipes.md`.

## State CLI and `feature set` keys

Plugin paths are relative to `${CLAUDE_PLUGIN_ROOT}`; artefact paths (`docs/features/…`, `docs/architecture/…`) to the **target project**. State changes go only through `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs <command>` (`--feature <dir>` overrides auto-detection, which ignores a closed feature, `current_phase == "done"`, for `check`, `recipe` and `gate` writes). Lessons live in `<project root>/.dev-cycle/lessons.md`.

Deterministic work runs through `check`, `git …`, `ship`; `dev-cycle:cli-fallback` is the only fallback agent (§1, §7). A PreToolUse hook (`scripts/git-guard.mjs`) denies state-changing git commands from subagents: a guardrail, not a security boundary.

`feature set <key> <value>` (JSON-parsed if it parses, else a string) writes the keys with no other writer: `current_phase`, `current_task_idx`, `task_count`, `branch`, `status` (`blocked|active`), `areas`, `models`, `design_source`, `owner_blocking`, `tdd`; any other key exits 2. Absent `.dev-cycle/project.json` (no profile) ⇒ current behaviour.

## 1. Lifecycle flows

### Feature flow

```
1. Feature-start interview (orchestrator → user; §4)
2. dev-cycle:discovery (only if `feature.json.discovery` != "skip"; `internal` = Internal mode only) → discovery.md
2b. `docs/architecture/overview.md` missing OR "architecturally significant?" yes → dev-cycle:architector
3. dev-cycle:spec-writer → spec.md [TODO]
4. If `design_source` is set skip the wireframer; else dev-cycle:wireframer → wireframes/*.html and a
   "Wireframe acceptance criteria" section appended to spec.md (one AC per visible column/state per
   screen, numbered continuously from spec-writer's last AC; binding for plan-writer + code-reviewer)
5. dev-cycle:plan-writer → plan.md (tasks [TODO] tagged frontend|backend|mixed|owner|content, with
   `Touches:` + `Depends on:`, plus `## Execution plan`). Skipped when `separate_plan == false`:
   spec-writer appends `## Tasks`, `## Execution plan`, `## Task details` to spec.md in the format of
   `${CLAUDE_PLUGIN_ROOT}/skills/plan-writer/references/task-format.md`; the CLI's tasks source is then
   spec.md (plan.md wins).
6. `git branch`: creates `feat/<slug>` from the default branch, sets `branch`, logs a `git` history
   entry. `main-ahead` or `auth` → escalate in one line; no agent.
7. Groups via the CLI (`groups`; `brief <n>` writes `briefs/task-<n>.md`): topologically sort tasks by
   `Depends on` into tiers; within a tier batch tasks with mutually disjoint `Touches` (overlapping
   siblings serialize). The plan's execution overview is documentation; groups are recomputed at dispatch.
8. PER GROUP (sequential between groups, PARALLEL within):
     a. `task <n> status "IN PROGRESS"` for each task
     b. one message, one Agent call per task (`orchestrator/references/parallel-groups.md`), by tag:
          - frontend → dev-cycle:frontend-dev; backend → dev-cycle:backend-dev
          - mixed → dev-cycle:frontend-dev (backend-dev if frontend-dev is skipped)
          - content → dev-cycle:backend-dev (whatever the stack token; the brief carries `## Recipe`)
          - owner → none (wait for owner)
        Owner tasks are never dispatched; content tasks always are. Prompt: orchestrator skill. Isolation: `orchestrator/references/worktrees.md`.
        Implementers run `check --scope touched --files <changed>` before DONE and list out-of-glob
        writes under `touches_expanded:`.
     c. wait for all reports; record each with `history add --agent-id <agentId>` (`--tokens` fallback):
        - DONE, no sibling collision → `task <n> status IMPL-DONE`
        - sibling collision → `history add` the conflict; the later task (plan order) reruns serially
          next cycle (counts against the 3-cycle limit, §8)
        - NEEDS_CONTEXT → finish the group, then re-dispatch serially next iteration with context
        - BLOCKED → status [BLOCKED]; escalate
9. All tasks [IMPL-DONE]: run `check --scope tree-wide --record` (no agent), then ONE parallel message:
     - dev-cycle:code-reviewer (whole-feature diff, always)
     - dev-cycle:auto-tester if auto_tests; dev-cycle:visual-tester if visual_tests or (a11y_audit && has_ui)
     - dev-cycle:security-reviewer if security_review or dependency_audit
     (modes independent; both flags true ⇒ one dispatch, both phases recorded)
   plus `gate run --all` when `profile.extra_gates` exist (none ⇒ "no extra gates", exit 0).
   `check` exit 0 PASSED, 1 FAILED (writes `static-check-report.md`, `checks/<step>.log`), 2 (no
   commands) → dev-cycle:cli-fallback (static-check mode) with the output.
   Review procedure: run `review snapshot` immediately before EVERY code-reviewer dispatch. Cycle 1
   reviews the whole-feature diff; cycles 2–3 get the `review diff --since-cycle <previous>` output
   reference plus the previous findings list, never the whole-feature diff.
   `visual teardown` is a mandatory fallback: when dev-cycle:visual-tester returns and
   `verification/teardown.json` is missing or older than the manifest's `last_activity`, run
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs visual teardown --feature <f>` before routing
   (stops only recorded devices and verified pgids; never the Playwright browser).
   After each end-gate round, before the final report, run
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs report --feature <f>`, print the index path.
10. Aggregate: all PASSED / APPROVED → step 12. Any failure:
     - parse `review.md` by `## Task N`; route other failing gates (`static-check-report.md` too) by
       file paths; cross-cutting findings go to the task whose `Touches` most overlap, none → escalate
     - the same `check` failure surviving a fix cycle → dev-cycle:cli-fallback (diagnose mode)
     - per affected task cycle_count += 1; > 3 → `task <n> status BLOCKED`, else `"IN REVIEW"`
     - re-dispatch fixes in parallel groups; re-run ONLY the previously failed end-gates; back to 9
12. dod-gate (`orchestrator/references/dod-gate.md`) via `dod`: passes only if every required gate's
    last `history` entry is `DONE` / `APPROVED` / `PASSED`.
    - `owner` tasks block dod only with `owner_blocking: true` (one `owner.task=<n>` key each, passing
      only when the task's status in the tasks source is `DONE`, not via history). Owner-task
      printing and confirmation rules: orchestrator skill, "Owner tasks".
    - PASSED → step 13. FAILED → one-line escalation naming the failing gate; abort before push.
13. Ship: `ship [--release auto] [--subject s] [--notes-file f]` replaces the old commit → push → pr → merge
    sequence, in order: `tokens orchestrator`; `dod`; release bump + CHANGELOG when `--release` is given;
    one feature commit that applies the flips inside it (`task --all-from IMPL-DONE --to DONE`,
    `spec status DONE`, a `git` "feature commit" history entry; secret-like files refused; a failed
    commit restores every snapshotted file byte-for-byte); push; PR; merge (CI wait, squash,
    `--delete-branch`, default branch pulled `--ff-only`); tag. Re-runs skip done steps. With
    `release_manage == true` pass `--release auto` unless the user named a level; notes and bump rules:
    `orchestrator/references/release.md`. Only the orchestrator, in the main session, runs `ship`; the
    verbs `tokens orchestrator`, `git commit [--trailer …] [--closes n,m]`, `push`, `pr`, `merge` remain
    for partial runs. Failures exit 1 with `<verb>: FAILED <reason> — <detail>`, routed per §7;
    committed `[DONE]` flips are never reversed when push / PR / merge later fails.
14. Post-merge (`profile.post_merge`): after the owner confirms, `post-merge run --all --confirmed`;
    logs go to `post-merge/*.log`.
```

### §1a Feature tracks

`feature.json.track` (`full | lite | quick`) sizes the Feature flow; it applies only when `flow == "feature"`. `feature init` without `--track` writes `quick` (prints `track: quick (default)`); an absent `track` in a legacy file counts as `full`. Selection and escalation rules are in the orchestrator skill. Each track is a set of deltas against the step numbers above.

- **full**: the Feature flow as written (`separate_plan == false` skips step 5; dod then has no `plan` gate).
- **lite** (no plan.md, no wireframes; spec.md is the brief):
  - Step 2 runs only if `feature.json.discovery` is explicitly `full` or `internal`; 2b keeps its trigger; 3 runs; 4 and 5 are skipped.
  - Steps 7-8 are replaced: the orchestrator splits the work into areas (`feature set areas`), dispatching one implementer per area (disjoint `touches` in one parallel message; overlapping areas serialize).
  - Steps 9-13 are unchanged, except: status flips touch spec.md only; end-gate findings route to the area whose `touches` most overlap (escalate if none), with the 3-cycle limit per area.
  - Owner and content tasks are full-track only; list owner steps in the final report.
  - The orchestrator appends spec.md's `## Threat notes` section (when present) verbatim to each implementer prompt, as it does lessons.
- **quick** (no spec.md, no plan.md): steps 2-5 and 7-8 skipped; one implementer gets the request text as its brief; gates: tree-wide `check --record`, code-reviewer, flag-enabled gates; commit needs `--subject`. Deltas:  `skills/orchestrator/references/quick.md`.

Lite and quick have no brief: the orchestrator appends `context --touches …` output per its dispatch rules. All three tracks produce one feature commit.

### Bugfix flow

```
1. Unambiguous report (repro, area, expected behaviour) → step 2, no interview or discovery;
   otherwise ask targeted questions, never guess.
2. `git branch` (CLI): creates `fix/<slug>` from the default branch
3. Dispatch the fitting frontend-dev or backend-dev to find the root cause and fix it:
   (a) reproduce reliably; (b) trace to the root cause and record the evidence (file:line,
   log, failing input), never patch symptoms; (c) write a failing test that captures it;
   (d) make the minimal fix; (e) re-run the test and the surrounding suite quietly
   (`check --scope touched --files … --steps test` or the project test command with a quiet
   reporter; never paste full test output)
4. Gates. Always: `check --scope tree-wide --record` and dev-cycle:code-reviewer (both required
   by dod; review is never skipped, even for a one-line change). By bug type: dev-cycle:auto-tester
   (logic/backend, regression test feasible), dev-cycle:visual-tester (frontend/UI). Findings route
   back for a fix cycle (max 3, §8).
5. `ship --subject <s>` (commit → push → PR → merge; squash, delete branch). Failures route per §7.
```

`feature init --flow bugfix` takes no `--track` (ignored with a stderr line; no `track` key), starts at `implement`.

### §1c Hotfix flow

Hotfix keeps the fully-interviewed shape (fixed interview, discovery, fixed test-gate set; production risk warrants asking up front) plus two deltas: `git branch` cuts from the **latest release tag**, and the merge commit is **cherry-picked** forward to `main` after merging (no CLI verb; `dev-cycle:cli-fallback`).

```
1. Hotfix-start interview (visual_tests? auto_tests? platform?)
2. dev-cycle:discovery (reproduce + root cause on the released code) → discovery.md
3. `git branch`: hotfix/<slug> from the latest release tag (`gh release view --json tagName`; `--base <ref>` overrides)
4. frontend-dev or backend-dev; 5. if auto_tests: auto-tester adds the regression test
6. `check --scope tree-wide --record`, then code-reviewer → APPROVED or fix loop (max 3)
7. if visual_tests (frontend bug): visual-tester
8. `git commit --subject <s>` → `git push` → `git pr --base <release branch>` → `git merge` (into the release line; runs dod first; `ship` has no `--base`)
9. dev-cycle:cli-fallback (git mode): cherry-pick the merge commit forward to main. On conflict:
   abort, surface the offending paths to the user, never auto-resolve.
10. The hotfix branch is deleted by the merge (`--delete-branch`).
```

Hotfix takes no `--track`, starts at `implement`. Cherry-pick recipe and conflicts: `${CLAUDE_PLUGIN_ROOT}/skills/cli-fallback/references/hotfix.md`.

## 4. Feature-start interview

**Feature flow:** asked once; answers go to `feature.json` via `feature init --answer k=v`. Pass `--answer` for **every** value the orchestrator decides (asked, inferred, corrected); omit only values left to profile/track defaults, or the CLI defaults silently replace them. Questions answered by the profile (`interview_defaults`, `platform`) are not asked; show them in one line `defaults from profile: … OK?`, and any override wins. No profile ⇒ unchanged:

1. Has UI? 2. Platform? (web|mobile, default web) 3. Has backend? 4. Architecturally significant? (default no) 5. Existing design provided? (path/URL) 6. Run automated tests? 7. Run visual tests at the end? 8. Discovery depth? full / internal / skip, asked last, **only for track `full`**, with a recommendation and one-line reason. `lite` and `quick` do not ask it: the default applies (`skip`, or `internal` with a project profile) unless the user volunteers a value.

The track is never asked (selection rules: orchestrator skill); it is written to `feature.json.track` before the first dispatch. `full` asks every question; `lite` all but discovery depth; `quick` none, inferring `has_ui`, `has_backend`, `auto_tests`, `visual_tests` as the bugfix flow does and asking only targeted questions when the request is ambiguous.

`separate_plan` (full only, default `true`) is never asked; for a medium full-track feature the orchestrator may pass `--answer separate_plan=false` and emit `> PLAN: tasks in spec — <reason>`. With `enabled_skills` in the profile, `feature init` forces the interview keys of skills that are not enabled (`discovery=skip`, `auto_tests=false`, `separate_plan=false`), overriding `--answer` and printing `! SKILL: <key>=<value> forced — <skill> not in enabled_skills`.

**Bugfix flow:** no fixed interview; the orchestrator infers `has_ui`, `has_backend`, `platform`, `auto_tests`, `visual_tests` from the report and a quick look at the area, records them (`feature init --flow bugfix`, no `--track`), and asks only when the report is ambiguous. **Hotfix flow:** keeps the fixed interview.

## 5. `feature.json` schema

```json
{
  "feature_slug": "user-login",
  "created": "YYYY-MM-DD HH:mm",
  "flow": "feature|bugfix|hotfix",
  "track": "full|lite|quick",
  "has_ui": true,
  "has_backend": true,
  "platform": "web|mobile",
  "design_source": "/absolute/path or URL or null",
  "auto_tests": true,
  "visual_tests": true,
  "current_phase": "discovery|spec|wireframe|plan|implement|review|test|git|done",
  "current_task_idx": 0,
  "task_count": 0,
  "branch": "feat/user-login",
  "started_at": "ISO",
  "sessions": ["<session id>"],
  "budget": { "usd": 50, "time_s": 7200 },
  "discovery": "full|internal|skip",
  "separate_plan": true,
  "skipped_skills": ["wireframer"],
  "models": { "frontend-dev": "opus", "cli-fallback": "haiku" },
  "owner_blocking": false,
  "profile": { "commands": {}, "extra_gates": [], "post_merge": [], "guards": [], "rules": [], "enabled_skills": [], "recipes": [] },
  "areas": [ { "name": "<kebab-case>", "touches": ["<glob>"] } ],
  "history": [
    { "ts": "ISO", "phase": "...", "subagent": "...", "status": "...", "model": "<resolved>", "duration_s": 0,
      "tokens_k": 0, "agent_id": "<id>", "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "by_model": {} },
      "estimated": false, "model_id": "claude-…", "usd_est": 0.0, "executor": "cli" }
  ],
  "totals": {
    "by_subagent": { "<name>": { "calls": 0, "approved": 0, "retried": 0, "time_s": 0, "tokens_k": 0 } },
    "by_model": { "<model>": { "calls": 0, "time_s": 0, "tokens_k": 0 } },
    "measured": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "billable_k": 0, "usd_est": 0,
                  "measured_entries": 0, "estimated_entries": 0 },
    "orchestrator": { "billable_k": 0, "usd_est": 0 }
  }
}
```

`track` is written only for `flow == "feature"`. `feature init` writes `started_at` and `sessions` (`[$CLAUDE_CODE_SESSION_ID]` or `[]`); `tokens orchestrator` appends the current session id when missing. `platform` is `web` when absent and only switches a gate's method (Playwright vs Maestro), never whether it runs.

### Optional keys

- `profile`: snapshot by `feature init` of whichever of `commands`, `extra_gates`, `post_merge`, `guards`, `rules`, `enabled_skills`, `recipes` the project profile has; `dod`, `gate run`, `post-merge run` and `brief` read only it. Interview defaults go to top-level keys. No profile ⇒ no key, unchanged behaviour.
- `track`: absent, or `flow` not `feature`, counts as `"full"`. See §1a.
- `areas` (lite): `feature set areas '<json>'` before the first dispatch; unique names.
- `feature.json.discovery`: an explicit override. When absent the default comes from `track`: full → `"full"`, lite/quick → `"skip"`; with a project profile present, `feature init` defaults full and lite to `"internal"` (precedence `--answer` > profile `interview_defaults.discovery` > default). An absent `track` counts as `full`. `full` lets the orchestrator pick external/internal/both; `internal` dispatches discovery in Internal mode only (no WebSearch, context7, WebFetch); `skip` dispatches nothing, writes no `discovery.md`.
- `models`: bare skill names → `haiku | sonnet | opus | inherit`; old names resolve as aliases with a warning, unknown keys are ignored (§10).
- `separate_plan`: boolean, written only for `feature` + `full`; default `true` (precedence `--answer` > profile `interview_defaults` > default, then `enabled_skills` forcing). `false` ⇒ plan-writer is skipped, spec-writer writes the tasks into spec.md, and dod drops the `plan` gate (and FAILs with gate `tasks` when spec.md has no `## Tasks`).
- `owner_blocking`: boolean (profile default, `--answer`, `feature set`), default `false` (§1 step 12).
- `skipped_skills`: sorted registry skills neither in `profile.enabled_skills` nor protected (protected, bare names: playbook, orchestrator, using-dev-cycle, spec-writer, frontend-dev, backend-dev, code-reviewer, cli-fallback). Written only when the profile has `enabled_skills`. See §10.
- `started_at`, `sessions`: the window `tokens orchestrator` sums (no `started_at` ⇒ first history `ts`).

### Project profile (`.dev-cycle/project.json`)

Optional, in the target project root; written by `init [--preset web|expo] [--force]` (no overwrite without `--force`), checked by `profile validate`. All keys optional: `platform` (`web|mobile`); `interview_defaults` (interview keys such as `has_ui`, `auto_tests`, `visual_tests`, `a11y_audit`, `dependency_audit`, `security_review`, `release_manage`, `static_check`, `owner_blocking`, `tdd`, discovery depth, `design_source`); `commands` (`lint|typecheck|test|format`); `extra_gates` and `post_merge` (`[{name, cmd}]`, post_merge also `confirm`); `enabled_skills` (registry skill names); `guards` (strings); `rules` (`[{globs, text}]`, injected into briefs by glob overlap with a task's Touches); `recipes` (grammar and run rules: `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/references/recipes.md`).

`gates/`, `post-merge/`, `content/` logs are committed with the feature folder: commands and recipes must not print secrets; warn the user if one looks like it would.

### History keys

Each `history[]` entry carries `"model": "<resolved>"` (literal `"inherit"` when `model` was omitted; none ⇒ `unknown`). `totals` (`by_subagent`, `by_model`, `measured`, `totals.orchestrator`) are recomputed from `history` by the CLI on every `history add`; never increment them by hand.

Measured keys (`history add --agent-id <id>`, transcript under `$CLAUDE_CONFIG_DIR` / `~/.claude`): `agent_id`; `tokens` (nested agents rolled up; only usage numbers and model ids leave transcripts); `estimated` (`true` when the transcript was missing and `tokens_k` came from `--tokens`); `model_id` (the `by_model` key with the most output); `usd_est` (shown as `~$<x> (estimate, prices as of <date>)`; unknown models add 0, listed in `usd_unpriced`); `tokens_k` (billable `(input + output + cache_write) / 1000`, cache reads excluded); `executor: "cli"` for entries written by `check --record`, `git branch`, `git commit`, `ship` (`subagent: "cli"`; they count for dod but not for `by_subagent` / `by_model`).

The single `phase: "orchestrator"` entry (`subagent: "orchestrator"`, `executor: "cli"`) is upserted by `tokens orchestrator` (main-session usage since `started_at`, across `sessions`); it is shown as `totals.orchestrator`, and `totals.measured` sums every entry with a `tokens` object, orchestrator included.

`phase`: implementers `implement.task=<n>` (full), `implement.area=<name>` (lite), `implement` (quick), `subagent` = the dispatched skill. CLI: `static-check` (`check --record`), `git` (`git branch`, `git commit`), `release` (`ship`, `DONE`, summary `<old> → <new>`), `phase: "orchestrator"`. Agents: `a11y` (dev-cycle:visual-tester a11y mode), `deps-audit` (dev-cycle:security-reviewer).

### Optional `budget` key

`{ "usd"?, "tokens_k"?, "time_s"? }`, at least one key. Absent ⇒ `usd: 50`, `time_s: 7200`; no default `tokens_k` check. `usd` is compared with `totals.measured.usd_est` (skipped while `measured_entries == 0`); `tokens_k` with counted entries' `tokens_k` plus the orchestrator entry; a legacy `{tokens_k: 50, time_s: 3600}` is honoured. The soft warning `! BUDGET: <reasons>; budget <k>=<v>…` lists keys in effect and never aborts or blocks dod. Format and scenarios: `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/references/dashboard-format.md`.

## 7. Routing rules

| Reported status | Orchestrator action |
|---|---|
| `DONE` | Mark task `[DONE]` (or advance phase), continue |
| `DONE_WITH_CONCERNS` | Log concern in `feature.json` history, continue |
| `NEEDS_CONTEXT` | Re-dispatch same subagent with the missing context |
| `BLOCKED` | Mark `[BLOCKED]`, escalate to user with blocker text |
| `APPROVED` (reviewer) | Advance to ship |
| `CHANGES_REQUIRED` (reviewer) | Re-dispatch implementer with `review.md`; max 3 cycles |
| `PASSED` (tester) | Continue |
| `FAILED` (tester) | Re-dispatch implementer with `test-report.md`; max 3 cycles |
| `check` exit 0 (`check: PASSED`) | Static-check gate passed; continue |
| `check` exit 1 (`check: FAILED <steps>`) | Re-dispatch implementer with `static-check-report.md` (routed by file paths); counts against the 3-cycle limit in §8 |
| `check` exit 2 (no check commands found) | Dispatch `dev-cycle:cli-fallback` (static-check mode) with `check`'s output |
| Same `check` failure after a fix cycle, implementer cannot resolve | Dispatch `dev-cycle:cli-fallback` (diagnose mode) with `check`'s failing output |
| Task tag `content` | content → dev-cycle:backend-dev (always dispatched; `## Recipe` brief) |
| Task tag `owner` | owner → none (wait for owner); print `> OWNER: Task <n> — <title> (waiting)` at phase boundaries and before `dod`; `task <n> status DONE` only on the user's explicit confirmation |
| Parallel group conflict (sibling collision) | Reschedule the later task serially next cycle; counts against the 3-cycle limit in §8 |
| `PASSED` (dod-gate) | `ship` (§1 step 13) |
| `FAILED` (dod-gate) | One-line escalation naming the gate; abort before push |
| `git`/`ship` reason `conflict`, `not-mergeable`, `push-rejected` | Dispatch `dev-cycle:cli-fallback` (git mode) with the `FAILED …` line |
| reason `hook-failed` | Hook output needs a code fix → implementer fix loop first, then retry the commit; `dev-cycle:cli-fallback` only if it still fails |
| reason `auth`, `main-ahead`, `ci-failing`, `ci-pending`, `dod-failed`, `secret-like-file` | Escalate to the user in one line (reason + detail); no agent |
| reason `timeout` | Retry once (`--gh-credential` if the keychain helper may hang); then escalate |
| reason `nothing-to-commit` | Escalate in one line; no agent |

After 3 failed fix cycles for a single task, set status to `[BLOCKED]` and escalate.

## 9. Dashboard format

See `orchestrator/references/dashboard-format.md` for the exact terminal layout.

## 10. Skill registry

Purpose, default model, and the flag that bypasses each skill; flow placement is in §1.

| Skill | Purpose | Model | Skip when |
|---|---|---|---|
| `dev-cycle:orchestrator` | Entry skill; drives every flow, never dispatched. | inherit | n/a |
| `dev-cycle:discovery` | Codebase grep / external research; `discovery.md`. | opus | `discovery == "skip"` |
| `dev-cycle:architector` | Architecture intake, ADRs, C4 Mermaid; `docs/architecture/*`. | opus | `overview.md` exists AND `architecturally_significant == false` |
| `dev-cycle:spec-writer` | `spec.md` (requirements, ACs, `## Threat notes`). | opus | bugfix flow; `track == "quick"` |
| `dev-cycle:wireframer` | HTML/CSS mockups per screen. | sonnet | `design_source` set; `track != "full"` |
| `dev-cycle:plan-writer` | Tagged tasks; `plan.md`. | opus | bugfix flow; `track != "full"`; `separate_plan == false` |
| `dev-cycle:frontend-dev` | Implements one frontend/mixed task end-to-end. | sonnet | task tag is `backend` only |
| `dev-cycle:backend-dev` | One backend/mixed task; migrations (`references/migrations.md`); content recipes. | sonnet | task tag is `frontend` only |
| `dev-cycle:auto-tester` | Unit / integration tests. | sonnet | `auto_tests == false` |
| `dev-cycle:code-reviewer` | Diff review against ACs; cycle ≥ 2 reviews the incremental diff. | opus | never |
| `dev-cycle:security-reviewer` | OWASP / secrets / authz review; once-per-feature dependency audit (phase/dod key `deps-audit`). | opus | both `security_review` and `dependency_audit` false; modes run on their own flags |
| `dev-cycle:visual-tester` | Playwright across 3 breakpoints (web) or Maestro (`platform == "mobile"`); a11y mode (phase/dod key `a11y`). | sonnet | `visual_tests == false` and no a11y (`a11y_audit == false` (default `visual_tests`) or `has_ui == false`) |
| `dev-cycle:cli-fallback` | Fallback for `check` (static-check and diagnose modes) and `git`/`ship` failures; owns the hotfix cherry-pick. | sonnet | Not dispatched by default. Only when `check` exits 2, the same `check` failure survives a fix cycle, `git` reasons `conflict`, `not-mergeable`, `push-rejected`, `hook-failed` need a code fix, or the hotfix cherry-pick (§1c step 9); static-check mode also skipped when `static_check == false` |

13 dispatchable skills (the registry above) plus playbook and using-dev-cycle. Old names stay as aliases (`enabled_skills`, `models`; resolved with a warning): `static-checker`, `git-agent` → `dev-cycle:cli-fallback`; `dependency-auditor` → `dev-cycle:security-reviewer` (dependency audit); `a11y-auditor` → `dev-cycle:visual-tester` (a11y mode); `db-migrator` → `dev-cycle:backend-dev` (`references/migrations.md`); `release-manager` → `ship --release`.

**`skipped_skills` dispatch rule.** On top of "Skip when", never dispatch a skill listed in `feature.json.skipped_skills` (protected ones never are): emit `> SKIP: <skill> — not in enabled_skills` and continue. `enabled_skills` only filters dispatch; Claude Code cannot disable plugin skills per project. Every dev-cycle skill except dev-cycle:orchestrator and dev-cycle:architector carries `disable-model-invocation: true` and is read by path, not through the Skill tool.

### Model resolution

Each registry skill has a default `Model`: `haiku`, `sonnet`, `opus` or `inherit` (omit the `model` parameter on the Agent call, so the subagent runs on the session model). Only these four values are allowed (no full model IDs). For a skill dispatch the first match wins:

1. `feature.json.models[<skill>]`, if present and valid;
2. code-reviewer at cycle ≥ 2 → `sonnet`;
3. an implementer on a doc task → `haiku`; a doc task is Size `S` with every `Touches` glob markdown (ends in `.md` or starts with `docs/`);
4. code-reviewer on track `quick` or flow `bugfix` → `sonnet`, unless the sensitive-change check in `skills/orchestrator/references/quick.md` matches;
5. the registry default.

There is no Size-based escalation: implementers default to sonnet; opus only via an explicit `models` override. An invalid override falls through and the orchestrator emits `! MODEL: ignoring invalid override <skill>=<value>`. `brief <n>` writes `**Model:** <value> (<reason>)` (reason `override`, `doc task` or `default`) for the task's implementer.

> `feature.json.static_check` is deliberately a noun, unlike the other `*_audit` / `*_tests` / `*_review` flags; it is not renamed.
