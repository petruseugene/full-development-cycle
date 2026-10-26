---
name: plan-writer
disable-model-invocation: true
description: Decomposes a feature spec into a task list. Writes plan.md with each task tagged frontend|backend|mixed (plus optional owner/content) and given a [TODO] status marker the orchestrator updates as work progresses.
---

# Plan Writer

## When to use

- Feature flow step 5, after spec-writer (and wireframer if applicable).
- Skipped when `feature.json.separate_plan == false`: spec-writer then appends the tasks to `spec.md` using the same `references/task-format.md`.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` — the playbook core. Read it before anything else.
2. `references/task-decomposition.md`
3. `references/sizing-heuristics.md`
4. `references/task-format.md`
5. `<feature folder>/spec.md`
6. `<feature folder>/wireframes/index.html` (if exists)
7. `<feature folder>/feature.json` (for `design_source`, `has_ui`, `has_backend`)

## The job

1. Read the spec's requirements and acceptance criteria.
2. Produce ordered tasks. Each task:
   - Has a clear, observable end state (something a reviewer can check)
   - Is sized 30-90 minutes of implementer time (see `references/sizing-heuristics.md`)
   - Is tagged with one stack token `frontend`, `backend` or `mixed`, optionally plus `owner` and/or `content`, comma-separated (e.g. `(backend, content)`, `(owner)`). `owner` = manual owner step, never dispatched, still needs `Touches` and `Depends on`. `content` needs `**Recipe:** <name>` from `profile.recipes`. Both: track `full` only (see `references/task-format.md`)
   - References specific files to create/modify (paths, where known)
   - Has step-level breakdown only when an implementer would benefit (small tasks can be one paragraph)
   - **For every AC the task covers, if that AC references a `wireframes/*.html` file, the task MUST include a `**Wireframes:**` line listing every such file as a relative path from the feature folder.** This is what the orchestrator forwards into the implementer's dispatch prompt — omit it and the visual contract leaks. If a task covers no wireframe-anchored ACs, omit the field entirely.
   - **MUST include a `**Touches:**` line** — a comma-separated glob list (best-effort estimate) of files the implementer is expected to write to. The orchestrator uses this to compute parallel groups via disjoint-globs partitioning. Prefer narrow globs over broad ones. List shared files explicitly (e.g., `package.json`, `tsconfig.json`, shared type modules) when they will be touched. See `references/task-decomposition.md` for rules.
   - **MUST include a `**Depends on:**` line** — a list of prerequisite task IDs whose output this task reads (types, schemas, components, endpoints), or the literal word `none`. Asymmetric — defines tier ordering, not file overlap.
   - **MAY include a `**Size:**` line** (`S|M|L`, after `**Depends on:**`). Missing means `M`. Size is informational only and never changes the model. See `references/task-decomposition.md`.
   - **Merge small tasks.** Merge Size-S tasks in the same tier that share a file owner (overlapping `Touches`, or the same single directory) into one task. Never merge owner tasks, and never merge tasks with a different stack tag. See `references/sizing-heuristics.md`.
3. Write `plan.md` with this frontmatter and heading, followed by the `## Tasks`, `## Execution plan` and `## Task details` sections exactly as defined in `references/task-format.md` (including the note that the Execution plan overview is documentation only):
   ```markdown
   ---
   feature: <slug>
   spec: ./spec.md
   status: [TODO]
   ---

   # <Feature> — Plan
   ```

## Output contract

```yaml
---
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: docs/features/<folder>/plan.md
summary: <N tasks; first task: <task 1 name>>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```

Final message: the YAML block above plus at most 5 lines of prose (playbook core §6).
