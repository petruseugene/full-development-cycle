# dev-cycle

![dev-cycle pipeline: the orchestrator dispatches discovery, spec, plan, implement, gates and git; failed gates loop back to implement](https://raw.githubusercontent.com/petruseugene/full-development-cycle/main/docs/assets/dev-cycle-pipeline.svg)

A [Claude Code](https://claude.com/claude-code) plugin that takes a feature or a bugfix from idea to merged pull request through strict subagent dispatch. The orchestrator never writes feature code itself. It interviews you, then dispatches specialised skills for each phase and keeps the state in plain files and a small CLI.

Pipeline: **discovery → spec → plan → parallel implementation → review and test gates → git (branch, commit, PR, merge)**.

On tracks `full` and `lite`, product decisions that spec-writer cannot settle are asked in one batched multiple-choice step before planning.

## Features

- **Orchestrator** with three tracks (`full`, `lite`, `quick`) plus bugfix and hotfix flows.
- **13 dispatchable skills plus a shared playbook and a routing skill**: orchestrator, architector, discovery, spec-writer, wireframer, plan-writer, frontend-dev, backend-dev, auto-tester, visual-tester, security-reviewer, code-reviewer, cli-fallback. Old names still work as aliases with a warning (profile `enabled_skills`, `feature.json` `models`): `static-checker` and `git-agent` are now `cli-fallback`, `dependency-auditor` is a section of `security-reviewer`, `a11y-auditor` is a mode of `visual-tester`, `db-migrator` lives in `backend-dev` (`references/migrations.md`), and `release-manager` is the `dev-cycle ship --release` command. The full old-to-new map is in [CHANGELOG.md](https://github.com/petruseugene/full-development-cycle/blob/main/CHANGELOG.md).
- **Git guard hook**: a PreToolUse hook on Bash that stops subagents from changing git state (see below).
- **Parallel groups**: tasks declare `Touches:` globs and `Depends on:`; the orchestrator batches glob-disjoint tasks and dispatches each batch in one message.
- **State CLI** (`scripts/dev-cycle.mjs`): deterministic, dependency-free Node commands for feature state, task statuses, parallel groups, checks, the definition-of-done gate and git/gh wrappers.
- **Per-task briefs**: a compact brief per task so each implementer starts with only what it needs.
- **Measured tokens**: per-agent and per-model usage read from Claude Code session logs, with cost estimates.
- **Project profile** (`.dev-cycle/project.json`): per-project defaults, check commands, extra gates, post-merge steps, guards and rules.
- **Dashboard**: a local Next.js board that watches `docs/features/` of your project.
- **Optional phases** toggled per feature: automated tests, visual tests, accessibility audit, dependency audit, security review, release management, static checks.

## Why dev-cycle

Built for and used daily on a production app. What it adds on top of a prompt-driven workflow:

- **Gates live on disk, not in the prompt.** Task status, history and the definition-of-done gate are kept in plain files by the state CLI. `ship` and `git merge` refuse to merge while a required gate's last entry is not `DONE`, `APPROVED` or `PASSED`, so a skipped review or test phase blocks the merge mechanically.
- **Visual verdict computed from measurements.** `visual check` and `visual verdict` compare screens against `profile.visual` (support, scale within a tolerance, overlap, tap-target size, forbidden colours) using the layout hierarchy, DOM rects and pixels. A vision estimate only fills a check the CLI could not measure and never overrides a measured failure.
- **Measured cost from transcripts.** `history add --agent-id` reads the subagent transcript (input, output and cache tokens per model, nested agents included) and attaches a USD estimate; it falls back to the agent's own estimate, with a warning, when no transcript is found. `report` breaks cost down per agent, model, phase and feature, with trends and a track comparison.
- **Owner and content work inside the flow.** `owner` tasks are manual steps the orchestrator waits on (`> OWNER: … (waiting)`) and closes only on your explicit confirmation. `content` tasks are briefed to run profile `recipes` through `recipe run`, which validates parameters and runs without a shell. `post_merge` steps marked `confirm: true` never run without `--confirmed`.
- **A project profile that is executed, not just read.** `commands` drive `check`, `extra_gates` are run by `gate run` and counted by the DoD gate, and `guards`, plus the `rules` matching a task's `Touches`, are written into its brief.
- **Process sized to the change.** `full`, `lite` and `quick` tracks, optional discovery, plan folded into the spec (`separate_plan: false`) and a per-skill model choice (`models`).
- **Parallel implementers with collision control.** Tasks run in groups with disjoint `Touches:` globs. Implementers report writes outside their globs, the orchestrator compares siblings, and a collision reschedules the later task serially. With optional `worktree start|collect`, out-of-globs writes are measured from each task's actual diff and changes are applied all-or-nothing.
- **Mechanics are scripts, not agents.** `check`, `git` and `ship` are deterministic CLI commands; the `cli-fallback` agent is dispatched only for documented failures. A git guard hook stops subagents from changing git state.

Limitations: Claude Code only, no public benchmark yet, and the git guard is a guardrail rather than a security boundary. Report gaps in [issues](https://github.com/petruseugene/full-development-cycle/issues).

### How it compares (as of Oct 2026)

A head-to-head run of OpenSpec, BMAD, Spec Kit and Superpowers on October 13, 2026 concluded: "None of the four records a human approval anywhere code can check" ([Felipe Fontoura](https://felipefontoura.com/articles/spec-driven-development-tools-compared/)). [Martian Lee](https://martianlee.github.io/posts/2026-06-01-spec-kit-vs-superpowers) describes Spec Kit's gates as built into its document structure and Superpowers' gates as prompt rules; BMAD models the lifecycle as agent personas and OpenSpec centres on delta specs for existing codebases [4].

| | dev-cycle | Superpowers | Spec Kit | BMAD | OpenSpec | GSD |
|---|---|---|---|---|---|---|
| Merge blocked by recorded gate state | `ship` / `git merge` DoD gate | no code-checkable approval [1] | no code-checkable approval [1] | no code-checkable approval [1] | no code-checkable approval [1] | — |
| Built-in token and cost tracking | per agent, model, phase | — | — | — | — | — |
| Visual test gate with a measured verdict | `visual verdict` | — | — | — | — | — |
| Subagent per task | yes, run in parallel `Touches`-disjoint groups | fresh subagent per task [2] | — | — | — | parallel waves [5] |
| Harnesses | Claude Code | 16, incl. Claude Code, Codex, Cursor [2] | 30+ agent integrations [3] | — | — | Claude Code, OpenCode, Gemini CLI, Codex [5] |

"—" means not described in the linked sources. Only dev-cycle and Superpowers were used hands-on; the others are assessed from their documentation and the published comparisons. Sources: [1] [Fontoura, head-to-head, Oct 2026](https://felipefontoura.com/articles/spec-driven-development-tools-compared/), [2] [obra/superpowers](https://github.com/obra/superpowers), [3] [Spec Kit vs Superpowers](https://martianlee.github.io/posts/2026-06-01-spec-kit-vs-superpowers), [4] [methodologies overview](https://claude-codex.fr/en/advanced/methodologies-ecosystem/), [5] [GSD wiki (third-party Mintlify mirror of the gsd-build repo)](https://mintlify.wiki/gsd-build/get-shit-done).

## Requirements

- Claude Code
- Node.js 22 or newer (the state CLI)
- bash
- [`gh`](https://cli.github.com/), authenticated, for opening and merging PRs
- For the dashboard only: `npm install` inside `dashboard/`

## What dev-cycle runs and sends

- **Hooks (local only):** `SessionStart` runs `scripts/session-start.sh` (injects a routing primer). `PreToolUse` on Bash runs `scripts/git-guard.mjs` (denies state-changing git from subagents).
- **State CLI:** `scripts/dev-cycle.mjs` runs `git` and, for `ship` and `git push|pr|merge`, the GitHub CLI `gh` with your own GitHub auth (pushes branches, opens and merges PRs, creates tags). The optional `--gh-credential` flag makes git use `gh` as its credential helper.
- **Codebase map:** `map` runs `git ls-files` / `git rev-parse` locally, reads only tracked `package.json` / `pnpm-workspace.yaml`, and has no network access.
- **Project profile commands:** `commands`, `extra_gates`, `post_merge` and `recipes` run only commands the project owner wrote in `.dev-cycle/project.json`. Post-merge steps with `confirm: true` need explicit confirmation.
- **Skills:** may run your project's test and lint tools, Playwright or simulators for visual tests, and `npx -y @axe-core/cli@4.13.0` for accessibility audits (downloads that pinned version from npm).
- **Dashboard (optional, local on 127.0.0.1:3737):** installs its npm dependencies automatically on first start. It calls `api.anthropic.com` (a `GET /v1/models` key check and Claude Agent SDK sessions) only when `DASHBOARD_AGENT` is not `off` and a key is set (auto mode validates the key with `GET /v1/models`), and reads `ANTHROPIC_API_KEY` from the environment or `dashboard/.env.local` for that. `ANTHROPIC_BASE_URL` overrides the host. The dashboard page loads web fonts from `fonts.googleapis.com` / `fonts.gstatic.com` in your browser.
- **Web access:** discovery and subagents may use Claude Code's web search and fetch tools.
- **Telemetry:** dev-cycle adds no telemetry of its own, and the dashboard sets `NEXT_TELEMETRY_DISABLED=1` to turn off Next.js telemetry. Claude Code and the Agent SDK follow their own settings.

## Installation

From GitHub:

```
/plugin marketplace add petruseugene/full-development-cycle
/plugin install dev-cycle@dev-cycle
```

From a local checkout:

```
/plugin marketplace add /path/to/full-development-cycle
/plugin install dev-cycle@dev-cycle
```

Update with:

```
/plugin marketplace update dev-cycle
```

To enable the plugin for everyone on a project, add this to the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "dev-cycle": {
      "source": { "source": "github", "repo": "petruseugene/full-development-cycle" }
    }
  },
  "enabledPlugins": { "dev-cycle@dev-cycle": true }
}
```

A SessionStart hook (`hooks/hooks.json` runs `scripts/session-start.sh`) injects `skills/using-dev-cycle/SKILL.md` into every new session so requests are routed to the right skill before the first reply. Changes to that file take effect after a session restart.

## Quick start

```
/dev-cycle:orchestrator add CSV export to the reports page
```

The orchestrator first picks a **track**, proposing one with a reason (and deciding by itself in obvious cases):

| Track | Use when | What runs |
|---|---|---|
| `full` | Large or cross-cutting work, new UI | Interview, discovery, spec, wireframes, plan, parallel implementation, all gates |
| `lite` | Medium work | Spec as the brief, no wireframes or plan; one implementer per area |
| `quick` | One area, a few files | A single implementer works straight from your request text |

`quick` (the default) and bugfix use a lean fast path: the orchestrator reads only the playbook core and `references/quick.md`, runs one implementer, then check, review and ship. The code-reviewer runs on `sonnet` and gets your request text as its acceptance source; a change touching security-sensitive paths or words (auth, secrets, hooks, guards, telemetry) keeps the opus default. The projected cost of a clean run is about $1.35 or less, a target rather than a measurement; verify it with `node scripts/dev-cycle.mjs report --feature <folder>`.

Bug reports use the **bugfix** flow: no fixed interview, the orchestrator infers what it needs, an implementer finds the root cause and fixes it, then review gates run. **Hotfix** keeps a fixed interview, branches from the latest release tag and cherry-picks the fix forward to `main`.

Other commands:

- `/dev-cycle:architector [topic]` - architecture intake: archetype trade-offs, `docs/architecture/` (overview, MADR ADRs, Mermaid C4) and workflow diagrams.
- `/dev-cycle:dashboard` - start the dashboard for the current project.
- `/dev-cycle:report` - generate the static HTML report (`report --all`) and print `.dev-cycle/report/index.html`.

While it runs, the orchestrator renders a progress dashboard in the terminal between phases:

![Orchestrator console dashboard: progress bar, per-subagent and per-model tables](https://raw.githubusercontent.com/petruseugene/full-development-cycle/main/docs/assets/orchestrator-console.png)

### Artifacts in your project

- `docs/features/<YYYY-MM-DD-HHh-MMm>-<slug>/`: `feature.json`, `discovery.md`, `spec.md`, `plan.md`, `review.md`, briefs and reports.
- `docs/architecture/`: overview, ADRs, diagrams.
- `docs/workflows/`: process and agent-stack diagrams.
- `docs/features/<f>/verification/`: visual-test gallery (`index.html`), written by `visual gallery`; self-ignored.
- `.dev-cycle/report/`: the generated HTML report (`index.html`); self-ignored.

**Codebase map.** `.dev-cycle/map.md` is a committed, deterministic overview of packages, script names, entry points, test runners and key directories, built from tracked files only; discovery maintains its `## Notes` section. It refreshes only at `feature init`, at discovery and on a manual `map`, and writes only when the content changes. It supplements CLAUDE.md and does not replace it. Briefs and lite/quick prompts get a slice of at most 2 KB for the paths a task touches. To measure the effect, compare the discovery and implementer token medians in `report --all` for features before and after the map. Examples: `node scripts/dev-cycle.mjs map --check`, `node scripts/dev-cycle.mjs context --touches "apps/web/**"`.

Task statuses: `[TODO]` → `[IN PROGRESS]` → `[IMPL-DONE]` → `[IN REVIEW]` → `[DONE]`, or `[BLOCKED]` at any step.

### `feature.json` toggles

The interview sets flags that enable optional phases: `auto_tests`, `visual_tests`, `a11y_audit`, `dependency_audit`, `security_review`, `release_manage`, `static_check`, `design_source`, plus:

- `track`: `full` (default when absent), `lite` or `quick`.
- `platform`: `web` (default) or `mobile`. It only switches the verification method in gates, not whether they run.
- `discovery`: `full`, `internal` or `skip`. The default comes from the track (`full` → `full`, `lite` and `quick` → `skip`), except that when a project profile exists, `full` and `lite` default to `internal`; an explicit value wins.
- `track` defaults to `quick` for `feature init` when `--track` is omitted (a notice is printed on stderr).
- `tdd`: boolean, default `false`. Set via profile `interview_defaults`, `--answer tdd=true` or `feature set tdd true`. Implementers run a RED→GREEN loop per unit (failing test first, then code), and the auto-tester switches to audit mode. Applies to every track and the bugfix flow.
- `models`: optional map of skill name to `haiku`, `sonnet`, `opus` or `inherit`, overriding the playbook's default model for that feature.

## Project profile

Optional file `.dev-cycle/project.json` in the target project. Validate it with `profile validate`. Allowed top-level keys: `platform`, `interview_defaults`, `commands`, `extra_gates`, `post_merge`, `enabled_skills`, `guards`, `rules`, `recipes`, `visual`, `worktrees`, `strict_tokens`.

```json
{
  "platform": "web",
  "interview_defaults": {
    "has_ui": true,
    "has_backend": true,
    "auto_tests": true,
    "tdd": true,
    "visual_tests": false,
    "dependency_audit": true,
    "release_manage": false,
    "discovery": "internal"
  },
  "commands": {
    "lint": "npm run lint",
    "typecheck": "npx tsc --noEmit",
    "test": "npm test",
    "format": "npx prettier --check ."
  },
  "extra_gates": [
    { "name": "e2e-smoke", "cmd": "npm run test:e2e -- --grep @smoke", "timeout_s": 600 }
  ],
  "post_merge": [
    { "name": "deploy-staging", "cmd": "./scripts/deploy.sh staging", "confirm": true }
  ],
  "enabled_skills": ["discovery", "wireframer", "auto-tester", "security-reviewer"],
  "guards": ["Never touch generated files under src/gen/"],
  "rules": [
    { "globs": ["src/api/**"], "text": "All handlers validate input with zod." }
  ],
  "worktrees": { "mode": "audit" }
}
```

Notes: `commands` accepts `lint`, `typecheck`, `test` and `format`; a command may contain an unquoted `{files}` placeholder for touched-scope runs. `interview_defaults` accepts `has_ui`, `platform`, `has_backend`, `architecturally_significant`, `design_source`, `auto_tests`, `visual_tests`, `a11y_audit`, `dependency_audit`, `security_review`, `release_manage`, `static_check`, `tdd`, `discovery` and `separate_plan`. Gate and post-merge names match `[a-z0-9-]+`; post-merge steps with `confirm: true` never run without `--confirmed`. Some skills are always enabled regardless of `enabled_skills` (playbook, orchestrator, using-dev-cycle, spec-writer, frontend-dev, backend-dev, code-reviewer, cli-fallback). `profile validate` prints "protected skill '...' is always enabled" warnings for protected skills left out of `enabled_skills`; they are expected and harmless. Claude Code cannot disable individual plugin skills, so `enabled_skills` only stops dispatch; it does not reduce prompt size.

### `profile.strict_tokens`
Optional boolean, default `false`. When `true`, `history add` for a dispatched subagent without `--agent-id` exits 2 instead of only warning, so token accounting stays measured.

```json
{ "strict_tokens": true }
```

### `profile.worktrees`
Optional worktree isolation for parallel task groups. Keys: `mode` (`off` default, `audit`, `auto`), `min_group` (integer >= 2, default 3), `dir` (repo-relative, default `.dev-cycle/worktrees`), `link` (globs symlinked into each worktree, default `**/node_modules`), `copy` (globs copied, default `.env`, `.env.*`) and `setup` (a command run inside each new worktree). `dir`, `link` and `copy` must be relative and contain no `..` segment. With `worktrees.mode` set to `audit`, groups still run in the shared tree and the CLI only records what isolation would have changed; `auto` runs eligible groups in isolated worktrees and merges them back with `worktree collect`. Expo and React Native projects usually want `"link": []` plus a `setup` command such as `npm ci`, because linked native dependency folders are not safe to share:

```json
{ "worktrees": { "mode": "audit", "link": [], "setup": "npm ci" } }
```

### `profile.visual`

Configures the `visual` CLI family: which screens are checked, how the app is built, and the numeric composition checks. All keys are optional.

```json
"visual": {
  "device": "<iOS simulator UDID (8-4-4-4-12 hex) | emulator-<n>>",
  "avd": "Pixel_8_API_35",
  "boot_timeout_s": 120,
  "tolerance_pct": 10,
  "tap_min_pt": 44,
  "forbidden_colors": ["#FF00FF"],
  "color_delta_e": 10,
  "color_min_pct": 0.5,
  "screen_timeout_s": 180,
  "budget_s": 900,
  "build": {
    "cmd": "npx expo run:ios --device {device}",
    "inputs": ["src/**", "app.json"],
    "serve": "npx expo start --port 8081"
  },
  "teardown": [],
  "screens": [
    {
      "id": "home", "title": "Home",
      "flow": "maestro --device {device} test -e OUT={out} flows/home.yaml",
      "screenshot": "home.png",
      "reference": "design/home.png",
      "timeout_s": 120,
      "touches": ["src/home/**"], "acs": ["AC3"],
      "elements": {
        "hero": "hero-id",
        "friend": { "id": "friend-id", "foot_offset_pct": 4, "support_offset_pct": 2 },
        "cta": "cta-id"
      },
      "checks": [
        { "type": "support", "element": "friend", "on": "hero" },
        { "type": "scale", "a": "friend", "b": "hero", "expect": 1.0 },
        { "type": "overlap", "a": "friend", "b": "cta" },
        { "type": "tap", "elements": ["cta"] },
        { "type": "colors" }
      ]
    },
    { "id": "about", "route": "/about", "elements": { "title": "title-id" } }
  ]
}
```

Check types: `support` (`element`, `on`), `scale` (`a`, `b`, `expect`), `overlap` (`a`, `b`), `tap` (`elements` list) and `colors` (uses `forbidden_colors`); checks name keys of `elements`, and `visual check` measures by their ids. A screen has either `flow` or `route` (route screens are driven by the agent and cannot be run with `visual run`). `screenshot` is a plain file name saved in `verification/`. Commands are argv, never run through a shell; `{device}`, `{out}` and `{screen}` are allowed placeholders.

Device guard: Accepted device shapes only (`{device}` is the selector; the selector comes BEFORE the subcommand): `maestro --device {device} test -e OUT={out} <flow>` (also `--udid`, `--device=`; `maestro test --device …` is refused), `adb -s {device} <sub> …` (`-d`/`-e`/`-t` refused), `xcrun simctl <sub> {device} …`, `npx expo run:ios|run:android --device {device}`, `react-native run-ios --udid {device}`, `flutter run -d {device}`, cap/cordova `--target {device}`, detox `--device-name {device}`, gradle/gradlew only with an `emulator-NNNN` device (pinned via `ANDROID_SERIAL`). Refused outright: `xcrun devicectl`, `ios-deploy`, `idevice*` tools. `xcodebuild` is effectively unsupported (the grammar cannot express `-destination id={device}`). Every visual command verifies that `visual.device` is a listed simulator or attached emulator before spawning; emulator commands get `ANDROID_SERIAL`. Physical devices are refused by `profile validate`, and `visual build` / `visual run` exit 2 without spawning anything. `visual.device` must be a simulator UDID or `emulator-<n>`. Teardown stops only devices and process groups the run itself started (recorded pgids are verified), so do not add `simctl shutdown` to `teardown`. Likewise, never put a port-killing command in `teardown`: it would also kill a Metro or dev server that you started yourself. The run records the process groups it starts (process groups recorded, each verified before it is signalled), and `visual teardown` stops exactly those and nothing else, so `teardown` is normally empty or holds only commands for resources the run owns.

## CLI reference

```
node scripts/dev-cycle.mjs <command> [args] [--json] [--feature <dir>]
```

Exit codes: `0` OK or PASSED, `1` FAILED, `2` usage, validation or parse error. Inside the plugin the path is `${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs`.

| Command | Purpose |
|---|---|
| `feature init <slug> --flow <feature\|bugfix\|hotfix> [--track <full\|lite\|quick>] [--answer k=v]...` | Create the feature folder and `feature.json` (`--track` defaults to `quick` for `feature`) |
| `feature set <key> <value>` | Set a `feature.json` key such as `current_phase` |
| `feature resume [--json]` | Read-only: rebuild the working context after compaction (tasks or areas, gates, what `dod` still needs, open decisions, budget) and print the exact `next:` commands |
| `task <n> status <S>` | Set one task's status |
| `task --all-from IMPL-DONE --to DONE` | Bulk status flip |
| `spec status <S>` | Rewrite the status in `spec.md` frontmatter |
| `spec amend --title <t> [--date YYYY-MM-DD] [--json]` | Insert an `## Amendment <date> — <t>` section with an `### Acceptance Criteria (amendment <date>)` heading and print `next AC: AC<n>` |
| `spec amend --supersede AC<x>=AC<y>[,AC<z>] [--json]` | Mark AC<x> as `**[superseded → AC<y>]**`; all pairs validated before one write |
| `spec analyze [--json]` | Read-only: report spec, task and coverage inconsistencies (errors exit 1, warnings exit 0) |
| `spec decisions [--json]` | Read-only: list the `## Open decisions` of `spec.md` (exit 2 on a malformed block) |
| `history add --phase <p> --subagent <s> --status <st> [--model m] [--duration d] [--tokens t] [--summary s] [--concerns c] [--agent-id id] [--session id]` | Append a history entry; measured usage is attached when an agent id is given; a dispatched subagent without `--agent-id` prints a `no --agent-id` warning (exit 2 under `strict_tokens`) |
| `groups [--all]` | Compute parallel groups from `Touches` and `Depends on` |
| `map [--check] [--force] [--json]` | Write or refresh the committed `.dev-cycle/map.md` from tracked files (`--check` is read-only; exit 1 when stale) |
| `context [--touches g,..] [--json]` | Read-only: print the lessons block for the globs plus the project-map slice (at most 2 KB) for a lite or quick prompt |
| `brief <n>` | Write `briefs/task-<n>.md` |
| `check [--scope touched\|tree-wide] [--files a,b] [--steps lint,typecheck,format,test] [--record] [--tail n] [--timeout s]` | Run read-only lint, typecheck, format and test commands. Test output is quiet: only failures are extracted and split into touched files versus elsewhere, and a non-zero test run is never reported as PASSED |
| `gate run <name>\|--all` | Run `extra_gates`; see the gate source rule below |
| `dod` | Read-only definition-of-done gate. On tracks `full` and `lite` it also fails with a `decisions` check while `spec.md` still has open decisions, and with a `spec-analyze` check on `spec analyze` errors |
| `post-merge run <name>\|--all [--confirmed]` | Run `post_merge` steps from the profile |
| `ship [--release major\|minor\|patch\|auto] [--subject s] [--body b] [--notes-file f] [--manifest path]... [--ci-timeout s]` | Replaces the old release-manager and git-agent happy path in one command: tokens, dod gate, optional version bump plus `CHANGELOG.md` (an `## [Unreleased]` heading becomes the version heading), commit, push, PR, merge and tag. Safe to re-run: finished steps are skipped |
| `init [--preset web\|expo] [--force]` | Write a starter `.dev-cycle/project.json` from `package.json` script names. Never overwrites without `--force`; never runs scripts |
| `review snapshot [--cycle n]` / `review diff [--since-cycle n] [--name-only]` | Incremental review: snapshot the working tree as a tree id (temporary index, real index untouched), then diff only what changed since a cycle |
| `profile validate` / `profile show [--json]` | Validate or print the project profile |
| `git branch [<name>] [--base <ref>]` | Create the feature or fix branch |
| `git commit [--subject s] [--body b] [--scope s] [--trailer "Key: value"]... [--closes n,m]` | Commit staged work with a conventional message |
| `git push` | Push the branch |
| `git pr [--base b] [--title t] [--body-footer text]` | Open the pull request |
| `git merge [--ci-timeout s]` | Merge (runs the dod gate first) |
| `worktree start\|collect\|remove\|list [args]` | Worktree isolation for parallel groups: `start` creates one worktree per task, `collect` applies each task's changes back to the main tree (all-or-nothing, conflicts reported, out-of-Touches paths listed), `remove` deletes worktrees recorded in the manifest, `list` shows active ones. Configured by `worktrees` in the profile |
| `visual plan\|build\|run\|mark\|check\|verdict\|gallery\|teardown [args]` | Visual verification: select screens, build once, run flows with time limits, compute composition checks, decide the verdict, write the gallery, stop what the run started (teardown is required before the verdict) |
| `report [--feature <dir> \| --all] [--out <dir>] [--json] [--no-network]` | Generate the static HTML report into `.dev-cycle/report/` (default `--all`) |
| `tokens agent <id> [--session s]` / `tokens orchestrator [--session s]` | Print measured token usage |

The `git` verbs also accept `--gh-credential` to use the `gh` credential helper.

**Closed features.** When no `--feature` is given, the CLI auto-detects the newest feature folder. A folder whose `current_phase` is `done` is closed: `check`, `recipe` and `gate` no longer write their records into it. An explicit `--feature <dir>` still works and keeps the existing path validation.

**Gate source (`gate run --all`).** Without a resolved feature, gates come from the project profile and the CLI prints `gates from project profile (.dev-cycle/project.json): N`. With an active feature, the snapshot taken at `feature init` wins and it prints `gates from feature snapshot (project profile: N gates)`. With no profile it prints `no extra gates`.

### Git guard hook

`hooks/hooks.json` registers a PreToolUse hook (`scripts/git-guard.mjs`, matcher `Bash`). When a subagent (stdin carries a non-empty `agent_id`) runs a state-changing git command (`checkout`, `switch`, `reset`, `restore`, `commit`, `rebase`, `merge`, `clean`, `cherry-pick`, `revert`, `am`, `pull`, `push`, `update-ref`), the hook denies it. The reason names the blocked verb and says "do not retry" and to ask the orchestrator, which owns git. Read-only git is untouched, and the orchestrator itself (no `agent_id`) is never blocked.

It is a guardrail against accidents, not a security boundary: it uses a hand-written tokenizer, fails open on any error, and `eval`, aliases, scripts that call git or `python -c` can bypass it. The one escape hatch is the `cli-fallback` skill: a command that starts with `DEV_CYCLE_GIT_FALLBACK=1 ` is allowed, and only that skill documents the marker.

## Dashboard

`/dev-cycle:dashboard` starts a local Next.js dashboard (http://127.0.0.1:3737) that watches `docs/features/` of the current project: a task board, per-feature detail, token and model spend, and an agent chat drawer. Install its dependencies once with `npm install` inside `dashboard/`. The sidebar has a "Report" link to the generated HTML report (see `/dev-cycle:report`). See `dashboard/README.md` for details.

![Dashboard board filtered to completed features: KPI strip, status columns and merged tasks](https://raw.githubusercontent.com/petruseugene/full-development-cycle/main/docs/assets/dashboard-board.png)

![Single-feature view with the spend-by-model table above the merged tasks](https://raw.githubusercontent.com/petruseugene/full-development-cycle/main/docs/assets/dashboard-feature.png)

Chat is billed at Anthropic API rates (Claude Agent SDK). Control it with `DASHBOARD_AGENT=auto|on|off`: in `auto` (the default) chat is hidden without a valid `ANTHROPIC_API_KEY`, and every `/api/agent/**` route returns 404. Force it with `/dev-cycle:dashboard --agent=on`, `--agent=off` or `--no-agent`, or set `DASHBOARD_AGENT` in `dashboard/.env.local`. Restart the dashboard after changing the env, the flag or the key. `on` skips the key check, so a Claude Code login can be used.

## Repository layout

```
.claude-plugin/   plugin.json, marketplace.json
commands/         /dev-cycle:orchestrator, :architector, :dashboard, :report
hooks/            SessionStart and PreToolUse (git guard) hooks
scripts/          dev-cycle.mjs (state CLI), git-guard.mjs, lib/, test/, lint-skills.sh,
                  run-dashboard.sh, session-start.sh
skills/           one directory per skill, plus playbook and using-dev-cycle
dashboard/        Next.js dashboard
docs/             design docs and artifacts of this repository's own development
```

## Development

```bash
node --test scripts/test/                          # CLI tests
bash scripts/lint-skills.sh                        # structural lint of SKILL.md files
claude plugin validate .                           # manifest validation
cd dashboard && npm test && npx tsc --noEmit       # dashboard tests (vitest) and typecheck
```

This repository's own `docs/features/` folders are local-only (git-ignored, never published); the CLI skips staging an ignored feature folder.

Conventions: the lifecycle lives in `skills/playbook/SKILL.md` (core, at most 4,800 bytes) and `skills/playbook/references/lifecycle.md`; the orchestrator (and architector, conditionally) read both by path and every other skill reads the core only, none through the Skill tool, and every skill except `dev-cycle:orchestrator` and `dev-cycle:architector` is flagged `disable-model-invocation: true` (enforced by the lint). Skill references in dispatches are always fully qualified (`dev-cycle:<name>`). To iterate without publishing, add your local checkout as a marketplace (see Installation).

Per-feature knowledge and task metadata:

- `lessons` — CLI commands that list and add project lessons; code-reviewer reports `lessons_added`, and relevant lessons are injected into task briefs.
- `recipe` — a profile-defined command template (`profile.recipes`) that a plan task can name; it runs only through `dev-cycle recipe run` with validated params, never by hand. Recipes run **without a shell**: `cmd` is split on spaces/tabs into argv words and each param value is passed as exactly one argument, verbatim. **Trust model:** the `cmd` is trusted, owner-authored code (like the script it calls); the CLI guarantees that param *values* are validated and never parsed by the CLI or a shell it starts. The cmd grammar is a best-effort lint against obvious footguns, not a sandbox: printable ASCII only, no shell syntax (`` ; | & $ ` < > ( ) { } ' " \ * ? [ ] ~ # `` or a newline) apart from `{param}` placeholders; a placeholder is a whole word (`{p}`) or the value of a `--flag={p}` word; the first word is a literal program that is not a shell (including variants such as `rbash`, `bash5`), command runner or shell builtin name (`env`, `xargs`, `sudo`, `time`, `find`, `read`, …); with placeholders, the later words of a plain program are checked for shells and runners too (wrappers such as `caffeinate` or `xcrun` forward their args; `.`/`source`/`exec`/`eval` only count as the program, so `git add . {p}` is fine); between an interpreter (`node`, `python3`, `npx`, `uv`, `expect`, …) and its script word there is no code flag (`-e`, `-c`, `-p`, `-r`, `--eval`, …) and no placeholder, the script word is not an `exec`/`install`/`tool`/`task`-style subcommand, and for `uv`/`pipx`/`bun`/`deno` `run` needs a literal script path (`uv run scripts/gen.py {p}`); words after the script are its own args (`python3 tools/gen.py -p {k}` is fine); and `npm`/`pnpm`/`yarn` take no placeholders (`npm run build -- {p}` hands the value to a shell). Programs that treat their own arguments as code, a program path or a package (`git -c {p}`, `make --eval={p}`, `rsync -e {p}`, `npx tsx {p}`) are the recipe author's responsibility. Example: `node scripts/tts.mjs --only {keys} --max-requests {n}`. Params may set `allow_dash: true` (values starting with `-` are otherwise rejected); values are limited to 1024 chars and a `pattern` must be a string of at most 256 chars without nested quantifiers. See `dev-cycle recipe --help`.
- `owner_blocking` — `feature.json` flag; when true, unfinished `owner` tasks block the dod gate (by default they do not).
- `owner` / `content` task tags — `owner` marks a manual step for the project owner (no agent is dispatched); `content` marks non-code work that goes to `dev-cycle:backend-dev`, needs `implement.task=<n>` for the dod gate and passes every end gate.

## Changelog

See [CHANGELOG.md](https://github.com/petruseugene/full-development-cycle/blob/main/CHANGELOG.md).

## License

[MIT](https://github.com/petruseugene/full-development-cycle/blob/main/LICENSE) © 2026 Eugene Petrus
