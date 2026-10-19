# Changelog

All notable changes to the dev-cycle plugin are documented here.
Format follows Keep a Changelog; versioning follows SemVer.

## [1.6.0] — 2026-10-19

### Added

- feat(scripts): worktree isolation for parallel task groups

### Added
- `worktree start|collect|remove|list` command: optional git worktree isolation for parallel task groups, with all-or-nothing collect, conflict reporting and manifest-confined cleanup.
- `worktrees` profile key (`mode`, `min_group`, `dir`, `link`, `copy`, `setup`) with validation and defaults; this repository dogfoods `mode: "audit"`.
- Worktree-aware feature resolution: the CLI finds the active feature folder from inside a worktree.

## [1.5.1] — 2026-10-19

### Fixed
- git-guard recognises glued redirects (`git stash>/dev/null`, `2>&1`, `<file`).
- `gate run` without a feature reports `log: null` / "logs discarded" after a passing run instead of a deleted path.
- `visual run` skips the subcommand word only right after the binary (and its leading `--opt value` pairs); project dirs named `build`/`test` elsewhere still anchor.
- `ship --release` prefixes a non-conventional `--subject` with `feat`/`fix` (+ `(--scope)`); CHANGELOG headings use an em dash.

### Changed
- `git commit`/`ship` work when the feature folder is git-ignored (not staged, one note line). This repository's own `docs/features/` and `docs/superpowers/` are now local-only.
- Marketplace author email uses the GitHub noreply address.

## [1.5.0] — 2026-10-19

### Changed

- cost cuts, skill merges, ship/init/review, subagent git guard (v1.5.0)

### Added
- `dev-cycle ship`: tokens, dod gate, optional `--release` bump plus changelog, commit, push, PR, merge and tag in one idempotent command.
- `dev-cycle init [--preset web|expo]` writes a starter project profile; `dev-cycle review snapshot|diff` gives incremental review across fix cycles.
- Git guard hook (`scripts/git-guard.mjs`): denies state-changing git commands from subagents. A guardrail, not a security boundary; `DEV_CYCLE_GIT_FALLBACK=1` is the cli-fallback marker.
- `cli-fallback` skill (static-check and git modes).

### Changed
- Skills merged, 20 to 15 folders (13 dispatchable). Old names remain as aliases with a warning. Capability map (old skill to new place):

| Old skill | Capability | New place |
|---|---|---|
| static-checker | Fallback check when `check` exits 2 (no commands) | `cli-fallback` static-check mode |
| static-checker | Diagnose mode for a persistent `check` failure | `cli-fallback` static-check mode (diagnose) |
| static-checker | `touched` (globs required) / `tree-wide` scopes, read-only, never `--fix` | `cli-fallback` + `references/tool-recipes.md`, `stack-detection.md` |
| static-checker | `static-check-report.md` sections | `cli-fallback` |
| git-agent | Failure reasons `conflict`, `not-mergeable`, `push-rejected`, `hook-failed` | `cli-fallback` git mode (marker `DEV_CYCLE_GIT_FALLBACK=1`) |
| git-agent | Hotfix `cherry-pick -x` forward-port PR, abort on conflict | `cli-fallback` + `references/hotfix.md` (lifecycle §1c link updated) |
| git-agent | No `--force` / `--no-verify` / `reset --hard`; commit message style | `cli-fallback` + `references/commit-message-style.md` |
| git-agent | Legacy branch / commit / push / pr / merge modes | already in the CLI `git` verbs; also composed by `ship` |
| dependency-auditor | npm / pip / cargo / govulncheck audit, threshold `dependency_audit_threshold` | `security-reviewer` dependency-audit section (`dependency_audit == true`), `references/audit-recipes.md` |
| dependency-auditor | License allow / review / deny on new direct deps | `security-reviewer` + `references/license-policy.md` |
| dependency-auditor | SBOM summary in `test-report.md`; dod key `deps-audit` | `security-reviewer` writes phase `deps-audit` |
| a11y-auditor | axe-core vs dev server (AA fail, AAA warn) | `visual-tester` a11y mode (`a11y_audit == true`, `has_ui == true`), `references/axe-recipes.md`, `wcag-aa-cheatsheet.md` |
| a11y-auditor | Mobile RN static a11y checks | `visual-tester` + `references/mobile-a11y.md` |
| a11y-auditor | dod key `a11y` | `visual-tester` writes phase `a11y` |
| db-migrator | Migration dir probe (incl. supabase, drizzle), authoring / validation | `backend-dev` `references/migrations.md` |
| db-migrator | Reversibility BLOCKER, zero-downtime concerns, mobile forward-only rules | `backend-dev` `references/reversibility-checks.md`, `zero-downtime-patterns.md`, `mobile-migrations.md` |
| release-manager | Conventional commits → semver bump (incl. 0.x rule) | `dev-cycle ship --release auto` |
| release-manager | Manifest version bump (package.json, pyproject, Cargo; monorepo by diff) | `ship` release step (+ `.claude-plugin/plugin.json`, `app.json`; `--manifest` for monorepos) |
| release-manager | Keep-a-Changelog section | `ship` heading + `--notes-file` body written by the orchestrator per `orchestrator/references/release.md` |
| release-manager | Expo version field + OTA-safe / native-build-required decision | `orchestrator/references/release.md` (orchestrator states it in notes and final report); `ship` bumps `expo.version` |
| release-manager | `release_manage` flag; history phase `release` | flag kept; `ship` records phase `release` |

- `check` prints quiet test output (failures only, touched vs elsewhere) and never reports PASSED on a failing test run.
- Closed (done) features are skipped by `check`, `recipe` and `gate` when auto-detected; `gate run --all` reads the project profile when no feature is resolved.
- `feature init` defaults to the `quick` track; discovery defaults to `internal` for full/lite when a profile exists.

### Fixed
- Device guard (#39): `ANDROID_SERIAL=` words rejected, `cross-env`/`dotenv`/`env-cmd`/`direnv` runners handled, phone-only tools matched correctly, `visual run` anchors path args, `visual mark --ac` repeatable.
- README teardown example no longer kills a foreign Metro (no `kill-port`); the old visual spec AC2 shows the passing `maestro --device {device} test flow.yaml` form.

## [1.4.0] — 2026-10-19

### Added
- `dev-cycle visual plan|build|run|mark|check|verdict|gallery|teardown`, configured by `profile.visual` (screens, references, elements, composition checks: support, scale ±tolerance, overlap, tap targets, forbidden colours). The CLI computes the verdict from measurements (layout hierarchy / DOM rects / pixels; vision numbers only fill unmeasured checks) — the model cannot soften a FAILED. Per-screen time limits, screens selected from the feature's Touches, build cache, local self-ignored gallery `verification/index.html`, mandatory teardown before the verdict (#26).
- Device safety: device commands must pass `{device}` in the tool's global selector position; the device is verified as a listed simulator or attached emulator before every spawn; emulator commands run with `ANDROID_SERIAL`; phone-only tools are refused; teardown stops only devices and processes the run itself started.
- `dev-cycle report`: model-free static HTML + JSON under `.dev-cycle/report/` — timeline with parallel lanes, fix cycles and waits; cost per agent / model / phase and cross-feature trend (measured vs estimated); track comparison with sample sizes; AC → tasks → tests map; gallery links; waiting-for-owner and unconfirmed merges. Strict CSP, everything escaped (#30).
- `## AC coverage — auto|visual` report sections (auto-tester / visual verdict) feed the AC map.
- `history add --agent-id` records transcript `started_at` / `ended_at`; owner task completion is recorded as `owner.task=<n>`.
- Dashboard: "Report" link and `/report` route.

### Fixed
- Dashboard `visual-diff` parser accepts the format the visual tester writes.

## [1.3.1] — 2026-10-19

### Security
- `recipe run` no longer uses a shell: the cmd is split into argv words and spawned with `shell: false`; param values are passed verbatim as single arguments. The old shell-quoting + denylist (bypassable) is removed.
- No-shell grammar enforced by `profile validate` and `recipe run`: no shell metacharacters, printable ASCII only, placeholders as whole words or `--flag={p}`, no shells / command runners / shell-builtin wrappers, interpreter code flags rejected before the script word, npm/pnpm/yarn take no placeholders.
- Trust model documented: the recipe cmd is trusted owner-authored code; programs that interpret their own arguments are the author's responsibility.

## [1.3.0] — 2026-10-19

### Added
- Skill catalog: 18 dispatch-only skills carry `disable-model-invocation: true`, so only `orchestrator` and `architector` are listed in every session and subagent. The orchestrator dispatches by absolute path (`Read <root>/skills/<x>/SKILL.md`); a lint rule forbids Skill-tool instructions that point at a flagged skill (#34).
- Playbook split: a ~3.7 KB core (shared contract) read by every skill, plus `playbook/references/lifecycle.md` read only by the orchestrator (was 38 KB for every dispatch) (#34).
- Session-start primer (~600 bytes, absolute plugin root filled in) replaces the full gateway injection (#34).
- Lessons memory: `.dev-cycle/lessons.md` and `dev-cycle lessons add|list|prune`; code-reviewer adds generalised rules on CHANGES_REQUIRED; briefs include matching lessons (newest first, max 10) (#29).
- Task types `owner` and `content`: `owner_blocking` DoD flag, `> OWNER:` waiting line, profile `recipes` run only via `dev-cycle recipe run` with validated, shell-quoted params and template safety checks; content tasks go to backend-dev with a `## Recipe` brief section (#27).
- Dashboard: "Waiting for owner" column, Owner / Content chips and filters, quick-add for owner/content tasks.

### Security
- Dashboard POST routes reject cross-origin requests (CSRF guard).
- Lessons text is sanitised on write and read (invisible / bidi characters stripped) and labelled as advisory data.

## [1.2.1] — 2026-10-18

### Added
- MIT `LICENSE` file.
- English README for public use: installation, requirements, quick start, project profile, CLI reference, development.
- "Dispatch pattern" section in `orchestrator/references/parallel-groups.md`; the bugfix flow has its own root-cause procedure.

### Changed
- All shipped files are in English.
- The plugin no longer references or depends on the `superpowers` plugin.

## [1.2.0] — 2026-10-18

### Added
- `dev-cycle check [--scope touched|tree-wide] [--files …] [--record]`: runs profile `commands` (or stack-detected lint/typecheck/format/test) and prints only failing output. Implementers and the end gate use it instead of the static-checker agent (#25).
- `dev-cycle git branch|commit|push|pr|merge`: one feature commit with status flips inside it, secret-like-file guard, byte-exact restore on failure, force-flag guard, dod-guarded squash merge with CI wait, `--gh-credential` / `DEV_CYCLE_GIT_CREDENTIAL=gh` for the osxkeychain hang. git-agent is now a fallback for conflicts, rejected pushes and hotfix cherry-picks (#25).
- Measured token accounting: `history add --agent-id` reads the subagent transcript (input / output / cache read / cache write per model, nested agents included), `tokens agent|orchestrator`, labelled USD estimate. YAML self-estimates remain as fallback with `estimated: true` (#23).
- `separate_plan`: with `separate_plan=false` spec-writer writes `## Tasks` into spec.md and plan-writer is skipped; groups / brief / task / dod and the dashboard read tasks from plan.md or spec.md (#28).
- `enabled_skills` in the project profile: skills not enabled are never dispatched (`skipped_skills`) (#28).
- Repository profile `.dev-cycle/project.json` for this repo.

### Changed
- Budget is `{usd?, tokens_k?, time_s?}` with defaults `{usd: 50, time_s: 7200}`; legacy budgets are honoured.
- One `isOwnerTask()` helper for dod, groups and bulk task operations.
- `feature init --track` is optional and ignored for bugfix / hotfix; their DoD uses the quick-track gate set, and code review is always required.

### Known limitations
- Claude Code cannot disable individual plugin skills, so skill descriptions still load in every session (follow-up #34).

## [1.1.0] — 2026-10-18

### Added
- Project profile `.dev-cycle/project.json`: interview defaults, `commands`, `extra_gates` (run as end gates and counted by the DoD gate), `post_merge` steps that need owner confirmation, `guards`, `rules`, `enabled_skills`. Without a profile, behaviour is unchanged (#31).
- State CLI `scripts/dev-cycle.mjs` (Node 22, zero dependencies): `feature init|set`, `task <n> status`, `task --all-from … --to …`, `spec status`, `history add` (totals recomputed from history), `groups`, `dod`, `gate run`, `post-merge run`, `profile validate|show`, `brief`. Tasks tagged `owner` are skipped by bulk operations (#22).
- Per-task briefs `briefs/task-<n>.md`; frontend-dev and backend-dev read the brief instead of the whole spec and plan, and return `NEEDS_CONTEXT` when it is not enough (#24).
- Per-skill model selection, feature tracks (full / lite / quick) and optional discovery (#21).
- Skills are platform-aware for React Native + Expo (#19).
- Parallel implementer dispatch and end-gate fan-in (#16).
- Dashboard: chat control panel built on the Claude Agent SDK (#17, #18), quick-add task, orchestrator-state pill, `/agents` catalog, pinned features.

### Changed
- The orchestrator changes task status, history and spec status through the CLI, not through Edit.
- static-checker: profile `commands` take precedence over stack detection.

### Fixed
- Dashboard no longer drops tasks marked `[IMPL-DONE]` or `[IN REVIEW]`.

## [1.0.0] — 2026-08-18

### Added
- Claude Code plugin packaging: `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`.
- Commands `/dev-cycle:orchestrator`, `/dev-cycle:architector`, `/dev-cycle:dashboard`.
- `scripts/run-dashboard.sh` — runs the dashboard against any project's `docs/features`.
- `dev-cycle:using-dev-cycle` gateway skill, auto-injected into every session by a SessionStart hook.
- Lint checks: frontmatter name matches directory, no legacy `.claude/skills` paths, no absolute paths, all dispatch references namespaced.

### Changed
- Skills moved from `.claude/skills/` to `skills/`.
- `_playbook.md` is now the `dev-cycle:playbook` skill, invoked by name instead of by path.
- All skill dispatch references are namespaced as `dev-cycle:<name>`.

### Removed
- Project-scoped `.claude/skills/` installation — the pack is consumed as a plugin, including in this repository.
