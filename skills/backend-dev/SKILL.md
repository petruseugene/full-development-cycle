---
name: backend-dev
disable-model-invocation: true
description: Implements one backend or mixed task end-to-end. Stack-agnostic — detects framework from package.json / pyproject.toml / go.mod. Produces working endpoints, services, or jobs that meet the task's acceptance criteria.
---

# Backend Dev

## When to use

- Per-task dispatch when task is tagged `backend` or `mixed` (and the mixed slice is server).

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` — the playbook core (shared contract). Read it before anything else.
2. `references/best-practices.md`
3. `references/pitfalls.md`
4. `references/stack-notes.md` (matching detected stack)
5. `references/examples.md`
6. The current task slice from `<feature folder>/plan.md` — on the full track, read `<feature folder>/briefs/task-<n>.md` instead (the brief is your primary input). Do not read `spec.md` or `plan.md` in full. If the brief is insufficient, return `NEEDS_CONTEXT` naming the missing information. Lite/quick: unchanged (spec.md / request text as dispatched).
7. Schema work: when an AC or the Touches mention schema, table, column, index or migration, read `references/migrations.md` (migration dir probe incl. supabase and drizzle, authoring, validation; with `reversibility-checks.md`, `zero-downtime-patterns.md`, `mobile-migrations.md`). Data loss in `down` is a reversibility BLOCKER unless the AC authorises it.
8. Content task: follow the brief's `## Recipe` and run only via `dev-cycle recipe run`.

## Preflight — read the dispatch envelope

Get your `Touches:` globs by track. Full: from `briefs/task-<n>.md` (Touches, Depends on and Files to read live only in the brief). Lite: from the `Touches:` line in the dispatch prompt. Quick: none; the request text is the brief. These are the file globs you're expected to write to. The orchestrator computed the parallel group on the assumption that your writes stay within these globs and don't overlap any sibling's globs.

- Stay within `Touches:` whenever you can.
- If you must write outside `Touches:` (a shared types file, a barrel export, a config), list every extra path under `touches_expanded:` in your final YAML report.
- This is a **soft, honor-based contract** — no tool blocks the write. The orchestrator uses your reported `touches_expanded:` to detect collisions with parallel siblings after the group completes. Underreporting expansions silently can corrupt a sibling's work.

## The job

1. **Detect stack** from manifest files. Note framework + ORM/DB driver + auth approach + test runner.
   Also probe `supabase/config.toml`: if it exists, the stack is Supabase — read the Supabase section of `references/stack-notes.md`.
2. **Re-read existing patterns** — find a similar handler/service/job and follow its conventions (file location, naming, error handling, test placement).
3. **Write code + tests together** when `feature.json.auto_tests == true`. Tests colocated per project convention.
4. **Run check commands**: typecheck, lint, test. Prefer `.dev-cycle/project.json` `commands` (`lint`, `typecheck`, `test`, `format`) when present. Fix errors before reporting DONE. Run tests with `node <CLI> check --scope touched --files <changed files> --steps test`, or the project test command with a quiet reporter. Never paste full test output into the report.
5. **Migrations** are their own task (per plan-writer's rules); follow `references/migrations.md` when the task is a migration. Do not sneak schema changes into a feature task.
6. **Stage but do not commit** — the orchestrator commits.

## Final step — check before reporting DONE

Before you emit your YAML report, run via Bash `node <CLI> check --scope touched --files <changed files>` (CLI path from the dispatch envelope; include `touches_expanded:` files).

- If it prints `check: PASSED`, proceed to the YAML report with `status: DONE`.
- If it reports FAILED, fix the issues yourself and re-run once. Do not round-trip to the orchestrator.
- If the second run still fails and you cannot fix it, emit `status: DONE_WITH_CONCERNS` and list the remaining findings under `concerns:`. The orchestrator may dispatch cli-fallback in diagnose mode, and its tree-wide `check` end-gate will catch it again.
- Exit 2 (no check commands found) is not a failure — note it and continue.

## Output contract

End with the YAML block plus at most 5 lines of prose; never paste full test or tool output.

```yaml
---
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: n/a
summary: <one sentence on what was implemented>
tokens_used: ~<N>k
duration: <Xm Ys>
touches_expanded: [<paths written outside the declared Touches globs; omit or [] if none>]
concerns: <only if DONE_WITH_CONCERNS>
---
```

`touches_expanded:` is optional. Absent or `[]` means "stayed within `Touches:`." A populated list is the honor-based signal the orchestrator uses for collision detection against parallel siblings.
