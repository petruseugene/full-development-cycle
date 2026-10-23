# Quick fast path

Self-contained rulebook for track `quick` (flow `feature`, the default) and flow `bugfix`. Read only the playbook core plus this file. Hotfix, or `visual_tests` / `a11y_audit` / `security_review` / `dependency_audit` true: do the full Required reading (SKILL.md items 2–3); on a flag only, §2, §4 and §6 here still apply. Escalation to `lite` or `full`: stop using this file and do SKILL.md items 2–3. Quick flips no statuses and has no groups, briefs, owner tasks or worktrees.

## 1. Setup
- State CLI: resolve once (`CLI="${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs"`, else `find ~/.claude/plugins -maxdepth 6 -path '*dev-cycle*/scripts/dev-cycle.mjs'`). Always `node "$CLI" <cmd> --feature <abs feature dir>`. Exit 0 OK, 1 FAILED, 2 usage or no commands. Put `State CLI: node <abs>` in every prompt. `<root>` = recorded plugin root.
- Track: never asked. Print `> TRACK: quick — <reason>` before any dispatch. Request spans several areas, a new screen or a new API (`lite`), or several subsystems or architecture impact (`full`): print one `> TRACK: lite|full — <reason>` line and leave this file for the full Required reading (SKILL.md items 2–3).
- Init: `profile show --json`, print `> defaults (project profile): …`. Infer `has_ui`, `has_backend`, `platform`, `auto_tests`, `visual_tests` (ask targeted questions only if ambiguous). `feature init <slug> --flow feature --answer k=v…` (one `--answer` per decided value; slug kebab-case, at most 40 chars), then `git branch` (`main-ahead` or `auth`: escalate in one line), then `feature set current_phase implement`.

## 2. Dispatch
Exactly one frontend-dev or backend-dev, by affected area (`mixed` → frontend-dev, or backend-dev when frontend-dev is in `skipped_skills`). Prompt, verbatim: "Read `<root>/skills/<x>/SKILL.md` and follow it. `${CLAUDE_PLUGIN_ROOT}` means `<root>`; `references/…` paths are relative to `<root>/skills/<x>/`. Do not call the Skill tool for dev-cycle skills." Then the feature folder (absolute), State CLI path, the reminder to end with the YAML report (playbook core §6), `feature.json`, and `Request (verbatim):` followed by the request text. Run `lessons list --touches "<globs>"` first (globs: paths the request names, else the implementer's reported files on a re-dispatch); append its output verbatim only when non-empty. A skill in `skipped_skills`: print `> SKIP: <skill> — not in enabled_skills`, do not dispatch.

Model: every Agent call passes `model` explicitly; an implementer's is never omitted and never `inherit`. Resolve: `feature.json.models[<skill>]` if valid and not `inherit` (else `! MODEL: ignoring invalid override <skill>=<value>`); else `haiku` when the request names at least one path and all are markdown (`*.md` or under `docs/`); else `sonnet`. The auto-tester and `dev-cycle:cli-fallback` get `sonnet` (or their override); the reviewer gets the model below.

Record each report: `history add --phase implement|review|auto-test --subagent dev-cycle:<x> --status <s> --model <m> --duration "<d>" --tokens "<t>" --agent-id <id> [--summary s] [--concerns c]`.

## 3. End gates
`check --scope tree-wide --record`: exit 1, re-dispatch the implementer with `static-check-report.md`; exit 2, `dev-cycle:cli-fallback` (static-check mode); the same failure surviving a fix cycle, cli-fallback (diagnose mode) with `check`'s output. Run `feature set current_phase review`, the sensitive check, then `review snapshot` (right before every reviewer dispatch, cycles 2–3 too) and one parallel message: `dev-cycle:code-reviewer` (prompt carries `Request (verbatim):` too; no spec.md exists, the request is the acceptance source), `dev-cycle:auto-tester` when `auto_tests`, `gate run --all` when `profile.extra_gates`. After each round run `report --feature <f>` and print the path.

Fix loop: CHANGES_REQUIRED or FAILED, re-dispatch the implementer with the artefact path; at most 3 cycles, then escalate. Cycles 2-3: reviewer gets `review diff --since-cycle <prev>` and the previous findings (sonnet). Re-run only failed gates. NEEDS_CONTEXT: re-dispatch once with the context, then escalate. CHANGES_REQUIRED with 0 findings: re-dispatch once.

## 4. Sensitive-change check
Before each cycle-1 reviewer dispatch. Changed paths: union of `git status --porcelain --untracked-files=all` and `git diff --name-only $(git merge-base HEAD <default branch>)..HEAD` (read-only; names only, never open files, `.env*` least of all). Matches when either holds:
- a path matches, case-insensitively: `**/*auth*`, `**/*secret*`, `**/*credential*`, `**/*passw*`, `**/.env*`, `**/*guard*`, `**/hooks/**`, `**/.husky/**`, `**/*telemetry*`, `**/*analytics*`, `**/*exec*`, `**/*shell*`, `**/*security*`, `**/*permission*`, `**/*approval*`, `**/*safety*`, `**/*loopback*`, `**/*token*`, `**/api/**`, `**/agent/**`, `SECURITY*`, `PRIVACY*`. `**/` matches zero or more leading directories (`hooks/hooks.json` matches `**/hooks/**`); `**/*x*` matches when any path segment, directory or file name, contains `x` (`skills/security-reviewer/SKILL.md` matches `**/*security*`);
- the request text contains, case-insensitively: `auth`, `secret`, `credential`, `password`, `token`, `telemetry`, `privacy`, `git-guard`, `hook`, `security`, `permission`, `approval`, `vulnerab`, `inject`, `api key`, `apikey`, `encrypt`, `disclos`.

Match: reviewer on the registry default (opus). No match: `sonnet`. A `models` override wins. Print one line: `> MODEL: dev-cycle:code-reviewer=<model> — <reason>`, reason `quick`, `sensitive: <first matching path or word>` or `override`.

## 5. Bugfix flow deltas
- `feature init <slug> --flow bugfix` (no `--track`; starts at `implement`), then `git branch` (`fix/<slug>`).
- Clear report: no interview or discovery. Ambiguous: targeted questions only.
- Implementer prompt adds root cause steps: (a) reproduce; (b) trace to the root cause with evidence (file:line, log), never patch symptoms; (c) failing test first; (d) minimal fix; (e) re-run quietly (`check --scope touched --files … --steps test`).
- auto-tester by bug type (logic or backend with a feasible regression test); review is never skipped.

## 6. Wrap-up
`dod`: exit 1 prints `! DOD-GATE FAILED: <gate> last status = <status or MISSING>; aborting before push.`; emit it and abort. Then `ship --subject "<s>"` (required on quick), adding `--release auto` when `release_manage` is true (`--release patch` if the owner says so). Ship failures: `conflict`, `not-mergeable`, `push-rejected` go to `dev-cycle:cli-fallback` (git mode); `hook-failed` needs an implementer fix first; `auth`, `main-ahead`, `ci-failing`, `ci-pending`, `dod-failed`, `secret-like-file`, `nothing-to-commit`: one-line escalation; `timeout`: retry once with `--gh-credential`. If `profile.post_merge` is non-empty, list the steps and ask the owner; only on an explicit yes run `post-merge run --all --confirmed`.

Output: one-line events (`> …`), no full dashboard table. If `usd_est` (needs `measured_entries > 0`) is over the default `$50` budget, print one `! BUDGET: …` line. Final report: `Feature complete: <slug>`, PR URL, branch, commit SHA, `report` path, totals (estimate).

## Verify cost
After shipping, run `report --feature <f>` and read `totals.measured.usd_est`. Target for a clean run (one `implement`, one `review`, no fix cycle) is about $1.35 or less. Check the per-subagent `model` column: implementer `sonnet`, reviewer `sonnet` unless the MODEL line said `sensitive`.
