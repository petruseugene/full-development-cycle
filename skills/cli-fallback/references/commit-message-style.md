# Commit message style (Conventional Commits-ish)

This file describes **two** commit message shapes:

1. **Per-task commit** — used by the **bugfix** and **hotfix** flows
   (one commit per APPROVED task). Unchanged from the original style.
2. **Feature commit** — used by the **feature** flow (one commit per
   feature, at the end, after dod-gate passes). See "Feature commit
   template" below.

The orchestrator (caller) may override either default — see
`SKILL.md` → "Caller-overrides take precedence".

## Per-task commit (bugfix / hotfix default)

```
<type>(<scope>): <subject>

<body — optional, wrapped at 72 chars>

Co-Authored-By: <trailer supplied by the orchestrator>
```

### Types
- `feat` — new functionality
- `fix` — bug fix
- `refactor` — no behaviour change
- `test` — tests only
- `docs` — docs only
- `chore` — tooling, deps, scaffolding

### Subject
- Imperative mood ("add login form", not "added").
- Lowercase first letter, no trailing period.
- ≤ 72 chars.

### Examples
```
feat(auth): add POST /api/login endpoint
```
```
fix(login): clear stale error after submit
```
```
refactor(auth-service): extract token signer
```

## Feature commit template (feature-flow default)

One commit per feature, composed at end-of-feature after dod-gate
passes. Template:

```
<type>(<scope>): <spec title lowercased>

<one-paragraph summary from spec.md "Problem" section>

Tasks:
- Task 1: <name>
- Task 2: <name>
- ...

Refs: docs/features/<slug>/spec.md

Co-Authored-By: <trailer supplied by the orchestrator>
```

### Inference rules
- `<type>`: derived from `feature.json.flow`:
  - `feature` → `feat`
  - `bugfix`  → `fix`
  - `hotfix`  → `fix`
- `<scope>`: the **most-touched top-level directory** across all tasks'
  `Touches:` globs. Count distinct file matches per top-level directory;
  pick the directory with the highest match count. Break ties
  alphabetically. If no `Touches:` data exists, fall back to the
  feature slug's first segment.
- `<spec title>`: first H1 of `spec.md`, lowercased, trailing
  punctuation stripped. Must be conventional-commit-friendly (no
  leading emoji, no markdown decoration).
- Summary paragraph: the first paragraph under `spec.md`'s `## Problem`
  heading. Fallback order: `## Summary` → spec subtitle (first line
  under the H1).
- Task list bullets: one per task from `plan.md`, formatted as
  `- Task <N>: <name>`. Use the human-readable task name (not the
  status marker).
- `<slug>`: the feature folder slug (the folder name directly under
  `docs/features/`).

### Example feature commit

```
feat(orchestrator): orchestrator parallel dispatch

The orchestrator skill is strictly sequential — the core playbook (`${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md`) §8 forbids
parallel dispatch in v1. For multi-task features, this means implementer
phases and end-of-feature gates each run one at a time even when they
have no real dependency on each other.

Tasks:
- Task 1: playbook skill edits
- Task 2: plan-writer skill — Touches/Depends on + Execution plan
- Task 3: code-reviewer skill — per-task tagged review.md
- Task 4: cli-fallback skill — scope=touched | tree-wide
- Task 5: frontend-dev skill — touches_expanded + scope=touched
- Task 6: backend-dev skill — touches_expanded + scope=touched
- Task 7: git commit flow — single feature commit
- Task 8: orchestrator SKILL.md — parallel groups + end-gate fan-in
- Task 9: new orchestrator references
- Task 10: existing orchestrator references
- Task 11: dogfood smoke-test

Refs: docs/features/2026-05-15-23h-57m-orchestrator-parallel-dispatch/spec.md

Co-Authored-By: <trailer supplied by the orchestrator>
```

## Bugfix / hotfix shape is UNCHANGED

The bugfix and hotfix flows continue to commit **per task** using the
**per-task** template at the top of this file. Do not regress those
flows to the single-commit shape — they are sequential single-track
flows and benefit from per-task granularity.

## Release compatibility

Both shapes are conventional-commits-compliant
(`<type>(<scope>): <subject>` header). `node <CLI> ship --release auto` parses
the subject and body to infer the semver bump (see the orchestrator's
`references/release.md`; only breaking changes raise the level, `feat` is a
patch, and a minor bump needs an explicit `--release minor`), so:

- Bugfix/hotfix: multiple structured commits; the highest bump implied wins.
- Feature: one structured commit; its header (and body footer) sets the bump.

## PR title
- Same convention but without the scope prefix usually:
  ```
  feat: user login (email + password)
  ```

## PR body template
```
## Summary
- <bullet from each task>

## Test Plan
- [ ] auto-tests passed: <link to test-report.md>
- [ ] visual tests passed: <link to test-report.md>

## Linked spec
docs/features/<folder>/spec.md
```
