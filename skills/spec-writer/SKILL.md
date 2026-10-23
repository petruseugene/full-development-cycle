---
name: spec-writer
description: Writes spec.md for a feature — problem, goals, non-goals, requirements, acceptance criteria, with the project's status frontmatter. Reads discovery.md first.
disable-model-invocation: true
---

# Spec Writer

## When to use

- Step 3 of the feature flow, after discovery, before wireframer / plan-writer.
- Never for bugfixes (bugfix flow has no spec).

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (the playbook core) before anything else; `${CLAUDE_PLUGIN_ROOT}` is the plugin root stated in your dispatch prompt.
2. `references/spec-template.md`
3. `references/good-vs-vague-examples.md`
4. `<feature folder>/discovery.md` (if exists)
5. `<feature folder>/feature.json` (for `separate_plan`)
6. Only when `separate_plan == false`: `skills/plan-writer/references/task-format.md`, `skills/plan-writer/references/task-decomposition.md`, `skills/plan-writer/references/sizing-heuristics.md`

## The job

1. Read `discovery.md` and the orchestrator's description of the feature. If `discovery.md` is absent (discovery skipped), do targeted reads of the files and areas named in the orchestrator's description instead; do not report NEEDS_CONTEXT solely because `discovery.md` is missing.
2. Produce `spec.md` using the template in `references/spec-template.md`. Frontmatter must include `status: [TODO]`.
3. Each requirement and each acceptance criterion must be checkable — written as a yes/no observable behaviour, not as "the system should be intuitive."
4. Non-goals are mandatory. State at least 3 things this feature is explicitly NOT doing.
5. Threat look. Check the feature against this list: exec/shell, file paths, auth/authz, network, secrets, device control. If the feature touches any of them, append `## Threat notes` to `spec.md` after `## 7. Out of Scope (v1)` (before any combined-mode sections). Write it as advisory, unnumbered bullets, each naming the risk and the guard an implementer should apply. It has no `dod` gate. If none of them applies, write no `## Threat notes` heading.

## Open decisions

Settle product forks with the owner instead of silently. Write `## Open decisions` (format: `references/spec-template.md`) after `## 7. Out of Scope (v1)` and before `## Threat notes` and any combined-mode sections.

- Only genuine **product** forks: observable behaviour, scope, UX copy, user-visible data shape, compatibility promises.
- Never what the profile or `feature.json` already answers (track, platform, `has_ui`, `has_backend`, tests, visual tests, discovery) and never pure implementation details: decide those yourself.
- Zero decisions is valid and expected for a clear request; write no section then.
- Each decision: `### D<n>: <question>` with 2-4 options `- <label> — <one-line consequence>`. Labels at most 5 words. The recommended option is first, and only it ends its label with ` (Recommended)`.
- Write requirements and ACs that depend on a decision against the recommended option and cite the id, e.g. `(D1)`.
- Never resolve a fork silently as "defaults applied".
- Decision lines never start with an `R<n>` or `AC<n>` id.

### Fold mode

When the dispatch prompt contains a `Decisions (owner answers):` block, edit the existing spec.md in place; do not rewrite it.

- Move each answered decision to `## Decisions` (`- **D<n>:** <question> → <answer> (<source>) — <consequence>`; source `owner`, `owner: other` for free text, or `owner: defaults OK` for `all: defaults OK`, which takes each recommended option). Update the requirements and ACs it affects.
- Never renumber existing AC ids. A dropped AC keeps its id with the text `(removed — D<n>)`; new ACs are appended after the last id.
- Remove `## Open decisions` when it is empty. Add a new open decision only when an answer creates a genuine new fork.
- Finish by running `node <State CLI> spec decisions --feature <feature folder>` as a self-check; it must print `no open decisions` (or only the new forks).

## Combined spec + plan mode (`separate_plan == false`)

When `feature.json.separate_plan == false`, there is no separate `plan.md` (plan-writer is skipped). After the last numbered section of `spec.md`, append three unnumbered sections, in exactly the format defined in `skills/plan-writer/references/task-format.md`:

- `## Tasks`
- `## Execution plan`
- `## Task details`

Decompose and size the tasks following `task-decomposition.md` and `sizing-heuristics.md` (every task needs `Touches:` and `Depends on:`). When `separate_plan` is `true` or absent, write only the numbered sections.

## Output contract

```yaml
---
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: docs/features/<folder>/spec.md
summary: <one sentence on what was specified>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```

Final message: the YAML block above plus at most 5 lines of prose (playbook core §6).
