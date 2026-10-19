# Worktree isolation (orchestrator)

Opt-in via profile `worktrees.mode` (`off` default, `audit`, `auto`). With `off` or absent, never call `worktree`; the flow is unchanged. Only code tasks (`frontend|backend|mixed`) are isolated. Only the orchestrator runs `worktree`; subagents run no state-changing git.

## When to call `worktree start`

Per group, before dispatch, when the group has >= 2 tasks and `mode != off`:

```bash
node <CLI> worktree start --tasks 2,3,4 --json   # {base, isolated, tasks:[{n, path|null}]}
```

- `auto` isolates only when eligible tasks >= `min_group` (default 3); below it, or in `audit`, every `path` is `null` and dispatch is unchanged.
- Exit 1 (setup or `worktree add` failed): nothing was created; run the group without isolation or fix `setup`, and tell the owner.
- Exit 2 with an active manifest: run `worktree list`, then `worktree remove --all`, and retry.

## Prompt lines

For each task with a non-null `path`, add to the dispatch prompt:

- `Worktree: <abs path>`
- the absolute main-tree feature dir (the subagent passes it as `--feature`)

Tasks with `path: null` get the normal prompt.

## `worktree collect`

After all reports of the group are in (and recorded with `history add`), run `worktree collect --json`. It applies each isolated task all-or-nothing, removes its worktree, clears the manifest and prints `{applied, conflicts, touches_expanded, stray}`. Exit 1 on any conflict or stray.

- **conflict** (task `n`): nothing of `n` was applied. Rerun `n` serially in the main tree, counted against the 3-cycle limit. Do not also `history add --phase conflict`; collect already recorded it.
- **touches_expanded**: for tasks that actually got a worktree (non-null path / `start` returned `isolated: true`) the collect result replaces the self-reported list in the collision check of `collision-and-fix-routing.md`. Non-isolated tasks (every task in audit mode, and auto below min_group) keep the self-reported `touches_expanded` check.
- **Records**: history group entries record `executor: "cli"`; manifest keys are `links` / `copies`.
- **stray** (changed in main, claimed by no applied or non-isolated task): route it to the task whose Touches overlap the path; if none, escalate to the owner.
- Then run `check --scope touched --files <union of applied paths>` in the main tree (combined state), before marking tasks `IMPL-DONE`.

## Lifecycle rules

- Never leave a manifest open across groups: every `start` is followed by `collect` (or `remove --all`) before the next group.
- Resume after a crash: `worktree list`; if active, `worktree remove --all` (applies nothing), then rerun the group.
- `worktree remove --task <n>` drops one worktree without applying it.
- Never remove worktrees with `git worktree remove --force` or `rm -rf`.

## Audit mode

`mode: "audit"`: `start` records the base and creates no worktrees; dispatch is unchanged. `collect` reports and records only `stray` paths (changed since base, covered by no task's Touches). Use it to measure drift before enabling `auto`.

## Risks

- **Expo / Metro / jest-haste-map**: symlinked `node_modules` and a second copy of the tree confuse watchers and haste maps. Keep the expo preset on `off`; if enabling, set `link: []` and install through `setup` (e.g. a frozen-lockfile install) so each worktree has real modules.
- **Monorepos**: `link` globs match every package's `node_modules`; check that tools resolving workspace links do not follow them back into main.
- **Shared caches**: build, jest and tsc caches under linked or repo-relative paths can be shared between worktrees; point them at per-worktree dirs or disable them in `setup`.
- Secrets: `.env*` files are copied (never linked) and are never applied back.
