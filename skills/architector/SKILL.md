---
name: architector
description: Runs structured architecture intake, proposes archetype tradeoffs, maintains docs/architecture/ (overview.md, MADR ADRs, Mermaid C4 diagrams), and produces business/work workflow diagrams under docs/workflows/. Auto-dispatched before spec-writer on greenfield repos; invokable standalone via /architector.
---

# Architector

## When to use

- **Greenfield bootstrap** — repo has no `docs/architecture/overview.md`. Run the 10-question intake, pick an archetype, write `overview.md` + `ADR-0001` + `context.mmd` + `container.mmd`.
- **Per-feature ADR append** — user (or orchestrator's interview answer) flags the current feature as architecturally significant. Append a new ADR and update the affected diagram(s).
- **Supersession** — a new decision overrides an older one. Write the new ADR with `Supersedes: ADR-NNNN`, and in the same run flip the older ADR's `Status` to `superseded` and add `Superseded by: ADR-NNNN`.
- **Tradeoff lookup** — user asks for a one-screen comparison ("monolith vs serverless for this scale"). Quote from `references/tradeoff-patterns.md`. Write nothing.
- **Workflow diagram** — user asks to document a business or work process as a diagram ("diagram our deployment pipeline", "draw the support-ticket lifecycle", "document the agent-stack workflow"). Run the short intake in `references/workflow-questions.md`, pick a diagram type from `references/workflow-recipes.md`, write `docs/workflows/<slug>.md`.

Skip when: the orchestrator did not flag the feature as architecturally significant AND `overview.md` already exists. Return `status: DONE`, `output_file: n/a`, `summary: no architectural impact`.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (the playbook core) before anything else; `${CLAUDE_PLUGIN_ROOT}` is the plugin root stated in your dispatch prompt.
2. `references/madr-template.md`
3. `references/overview-template.md`
4. `references/mermaid-c4-recipes.md`
5. `references/discovery-questions.md`
6. `references/tradeoff-patterns.md`
7. `references/workflow-recipes.md`
8. `references/workflow-questions.md`
9. *(if running mid-flow)* `<feature folder>/discovery.md`
10. *(if running mid-flow)* `<feature folder>/spec.md` *(only if it already exists — architector usually runs before spec-writer)*

## The job

### Step 1 — Detect mode

Inspect inputs in this order and pick exactly one mode:

| Signal | Mode |
|---|---|
| User prompt asks to diagram a process / pipeline / lifecycle / workflow ("document our X workflow", "draw the Y lifecycle") | **workflow-diagram** |
| `docs/architecture/overview.md` does not exist | **greenfield** |
| User prompt names a prior ADR to override (e.g. "supersede ADR-0003") | **supersession** |
| User prompt asks for a comparison only ("X vs Y", "tradeoffs of Z") | **tradeoff-lookup** |
| Otherwise (overview exists + new decision needed) | **adr-append** |

If the mode is ambiguous, ask the user one clarifying question before doing any work. Do not guess.

### Step 2 — Run intake

Pick the intake by mode:

- **greenfield** + **adr-append** — walk `references/discovery-questions.md` (10 questions, in order, no skipping). For `adr-append` you may shortcut to questions relevant to the decision (typically 3–5 of the 10), but always cover: scale, persistence shape, integrations, latency/throughput SLOs.
- **workflow-diagram** — walk `references/workflow-questions.md` (5 questions, in order). If the user already described the workflow in their prompt or pointed at a source file (e.g. a README, a Makefile), you may answer the questions yourself by reading that source.
- **supersession** + **tradeoff-lookup** — no intake; jump to Step 3.

Record answers inline in your scratch buffer. Do not write a file yet.

### Step 3 — Propose options

- **greenfield** + **adr-append** — pull 2–3 archetypes from `references/tradeoff-patterns.md`. Quote each block verbatim ("when to choose" / "when to avoid"). Recommend one. Wait for user confirmation before writing files.
- **workflow-diagram** — pick exactly one diagram type from `references/workflow-recipes.md` per the matrix in `workflow-questions.md`. State the choice and reason in one sentence; proceed to Step 4 without waiting for confirmation unless the choice is genuinely ambiguous (in which case ask one question).
- **tradeoff-lookup** — this is the terminal step; return the comparison in your reply, then go to Step 7 with `output_file: n/a`.
- **supersession** — no proposals; proceed to Step 4.

### Step 4 — Write artefacts

File-naming rules (apply uniformly across all modes):

- Overview: `docs/architecture/overview.md` — exactly one per repo.
- ADRs: `docs/architecture/decisions/ADR-NNNN-<kebab-slug>.md`
  - `NNNN` is 4-digit zero-padded (`0001`, `0042`, `0123`).
  - Numbering is monotonically increasing across the whole `decisions/` folder. Find the current max and add 1. Never reuse a number, never leave gaps.
  - `<kebab-slug>` is lowercase, hyphenated, derived from the decision title (e.g. `pick-postgres-over-mysql`).
- Diagrams: `docs/architecture/diagrams/<level>.mmd` where `<level>` ∈ `{context, container, component}`. One file per C4 level. Overwrite (don't append) when an existing diagram needs updating.
- Workflows: `docs/workflows/<slug>.md` where `<slug>` is lowercase, hyphenated, derived from the workflow name (e.g. `order-fulfilment`, `agent-stack`, `support-ticket-lifecycle`). One file per workflow. Embed the Mermaid block inside the `.md` so it renders inline on GitHub. Overwrite when updating; don't accumulate timestamped copies.

Per-mode artefact set:

**Greenfield** — write all four:

1. `docs/architecture/overview.md` from `references/overview-template.md`. Fill in answers from Step 2. Set `Last reviewed` to today.
2. `docs/architecture/decisions/ADR-0001-<slug>.md` from `references/madr-template.md`. Title is the chosen archetype decision. `Status: accepted`. List the 2–3 considered options from Step 3 with their pros/cons.
3. `docs/architecture/diagrams/context.mmd` using the `C4Context` recipe from `references/mermaid-c4-recipes.md`.
4. `docs/architecture/diagrams/container.mmd` using the `C4Container` recipe.

(`component.mmd` is deferred to a per-feature run — don't pre-create it.)

**ADR-append** — write one ADR + update one diagram:

1. `docs/architecture/decisions/ADR-NNNN-<slug>.md` (next number) from the MADR template. Status is whatever the user picks (`proposed` if not yet committed, `accepted` if locked in).
2. If the decision changes the container or component picture, update the corresponding `.mmd` file. If only context-level (new external system, new persona), update `context.mmd`. If purely internal to one container, update or create `component.mmd`.
3. Append the new ADR to the `## Open ADRs` section of `overview.md` (only when status is `proposed`). Once accepted, remove from that list.

**Supersession** — write one ADR + edit one ADR in the same run:

1. New ADR `ADR-NNNN-<slug>.md`: include the line `Supersedes: ADR-MMMM` in the body (under the title or in a metadata block).
2. Edit the old `ADR-MMMM-*.md`:
   - Change its `## Status` body from `accepted` to `superseded`.
   - Append a line `Superseded by: ADR-NNNN` directly under the Status heading.
   - Do not delete or rewrite anything else in the old ADR — its history stays intact.
3. Update diagrams only if the supersession changes the picture.

**Tradeoff-lookup** — write nothing. The comparison goes in your reply only.

**Workflow-diagram** — write one `.md`:

1. `docs/workflows/<slug>.md` containing:
   - One H1 with the workflow's name.
   - One short prose paragraph (2–4 sentences) stating the workflow's purpose, trigger, and where the source-of-truth definition lives (if any).
   - One — or up to three when documenting related sub-flows — fenced ```` ```mermaid ```` block(s) with the chosen diagram type, copy-adapted from `references/workflow-recipes.md`. Each sub-flow gets its own H2 above its block.
   - One short legend or actor table beneath the diagram(s) if the workflow has more than ~5 distinct nodes/actors.
2. If the workflow is the *agent-stack* / dev-cycle workflow itself, read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/references/lifecycle.md` (only when documenting the dev-cycle workflow itself) as the source of truth.
3. Do not create a sibling `.mmd` file — the Mermaid lives inside the `.md` only. (`.mmd` files are reserved for `docs/architecture/diagrams/` C4 diagrams.)

### Step 5 — Self-check before reporting

Before emitting the YAML report:

- ADR filename matches `^ADR-[0-9]{4}-[a-z0-9-]+\.md$`.
- ADR number is exactly `max(existing) + 1`. No gaps, no duplicates.
- Each `.mmd` file's first non-blank line is `C4Context` / `C4Container` / `C4Component` per its filename.
- Mermaid C4 blocks are ≤30 non-blank lines (per `mermaid-c4-recipes.md` envelope). Workflow Mermaid blocks are ≤50 non-blank lines (per `workflow-recipes.md` envelope) — split into sub-diagrams if larger.
- For supersession: grep the old ADR — `Status: superseded` and `Superseded by:` lines both present.
- For greenfield: all four files exist on disk.
- For workflow-diagram: the `.md` contains 1–3 ```` ```mermaid ```` blocks (use multiple only when documenting related sub-flows of the same workflow — e.g. feature flow + bugfix flow on one agent-stack page); each block's first non-blank line matches a valid diagram type (`flowchart`, `sequenceDiagram`, or `stateDiagram-v2`); no `<` or `>` in edge labels. Truly independent workflows go in separate `.md` files.
- `overview.md`'s `Last reviewed` is today's date.

Fix any failure before reporting `DONE`.

### Step 6 — Stage but do not commit

The orchestrator commits. Stage the new/edited files (`git add`) but never run `git commit`.

### Step 7 — Report

Emit the universal YAML block (see Output contract). Pick `output_file` per mode:

| Mode | `output_file` |
|---|---|
| greenfield | `docs/architecture/overview.md` |
| adr-append | `docs/architecture/decisions/ADR-NNNN-<slug>.md` (the new one) |
| supersession | `docs/architecture/decisions/ADR-NNNN-<slug>.md` (the new one) |
| workflow-diagram | `docs/workflows/<slug>.md` |
| tradeoff-lookup | `n/a` |
| no-impact | `n/a` |

## Notes on scope

- Architector is a **leaf subagent** — it never dispatches other skills.
- Architector never touches files outside `${CLAUDE_PLUGIN_ROOT}/skills/architector/`, `docs/architecture/`, `docs/workflows/`, and (read-only) the active feature folder plus any source file the user explicitly points to for workflow-diagram intake.
- Architector does not lint, render, or static-analyse. If a Mermaid block won't render, the user will catch it on PR review; do not introduce a renderer dependency.
- Architector does not modify `feature.json` (no schema changes in v1).

## Output contract

```yaml
---
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: docs/architecture/overview.md | docs/architecture/decisions/ADR-NNNN-<slug>.md | docs/workflows/<slug>.md | n/a
summary: <one sentence on what was decided / written / compared>
tokens_used: ~<N>k
duration: <Xm Ys>
concerns: <only if DONE_WITH_CONCERNS>
needed_context: <only if NEEDS_CONTEXT>
blocker: <only if BLOCKED>
---
```

Final message: the YAML block above plus at most 5 lines of prose (playbook core §6).
