---
name: cli-fallback
description: Fallback for the state CLI's static check and git commands. Static-check mode (read-only lint/typecheck/format, diagnose of a failing `check`) and git mode (conflict, not-mergeable, push-rejected, hook-failed, hotfix cherry-pick). Dispatched only when `check` or `git` fails.
disable-model-invocation: true
---

# CLI Fallback

## When to use

Fallback only; routine work runs through `node <CLI> check` and `node <CLI> git ...`.
- **static-check:** `check` exits 2 (no commands found) and a judgment-based check is wanted, or diagnose mode (the prompt includes the failing `check` output: explain the root cause per step, propose fixes, stay read-only). Skipped when `feature.json.static_check == false`.
- **git:** `git` failed with reason `conflict`, `not-mergeable`, `push-rejected` or `hook-failed`, or the hotfix `cherry-pick` is needed.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (shared contract).
2. static-check: `references/stack-detection.md`, `references/tool-recipes.md`. git: `references/commit-message-style.md`; `references/hotfix.md` only for the `hotfix` flow.

## The job

Two modes; pick by the dispatch prompt.

### Static-check mode

Params: `scope` = `touched` | `tree-wide` (default `tree-wide`); `globs` required for `touched`, else return `BLOCKED` with `reason: scope=touched requires globs`.
1. Detect tooling per `stack-detection.md`; run per `tool-recipes.md` (for `touched`, only files matching `globs`).
2. Read-only: never pass `--write`, `--fix`, `-w`. A formatter that would change files is a FAILED finding.
3. Append to `<feature folder>/static-check-report.md`: `## Task <N> static-check — <ISO ts> — scope=touched — PASSED|FAILED` or `## End-gate static-check — ... scope=tree-wide ...`, one bullet per tool (`- [pass] eslint (files)` / `- [fail] tsc — path:line msg`).
4. PASSED if every tool exits 0, else FAILED.

### Git mode

Fix the failure in the working tree, then retry through the CLI. In a subagent, every state-changing git call is denied unless it starts with `DEV_CYCLE_GIT_FALLBACK=1 `, and that includes CLI retries: `DEV_CYCLE_GIT_FALLBACK=1 node <CLI> git push`, `DEV_CYCLE_GIT_FALLBACK=1 git cherry-pick -x <sha>`. The marker covers only the one command it prefixes; never chain commands (`&&`, `;`, `|`) behind a single marker, prefix each separately.
- `conflict`: resolve or return `BLOCKED` with the failing paths. `not-mergeable`: rebase/merge the base, report. `push-rejected`: fetch, integrate, push again. `hook-failed`: fix the cause and make a NEW commit.
- `cherry-pick <merge_sha> <target>` (hotfix): per `references/hotfix.md`, `git cherry-pick -x` on a `chore/cherry-pick-<short-sha>-to-<target>` branch, push, open the forward-port PR. On conflict `git cherry-pick --abort` and return `BLOCKED`.
- Commit messages follow `references/commit-message-style.md`; the trailer text comes from the orchestrator, never hard-code a model name.
- Never `--force`, never `--no-verify`, never `reset --hard`. If `gh` is unauthenticated return `BLOCKED` with instructions.

## Output contract

Final message: the YAML block plus at most 5 lines of prose (playbook core §6).

```yaml
---
status: PASSED | FAILED | DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: docs/features/<folder>/static-check-report.md | n/a
summary: <one sentence; scope/globs/failures_count/affected_files for static-check>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```
