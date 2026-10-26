---
name: discovery
description: Two-mode discovery skill. External mode researches libraries / docs / prior art via WebSearch + context7. Internal mode greps the codebase to map relevant files, flows, and dependencies. Writes findings to discovery.md.
disable-model-invocation: true
---

# Discovery

## When to use

- Before spec-writer, to ground the spec in real options and real code
- Before bugfix implementation, to reproduce + locate root cause

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (the playbook core) before anything else; `${CLAUDE_PLUGIN_ROOT}` is the plugin root stated in your dispatch prompt.
2. `references/search-recipes.md`
3. `references/library-lookup.md`

## The job

1. Read the orchestrator's prompt to determine **mode**:
   - **External**: research libraries, patterns, prior art (use WebSearch, context7, WebFetch)
   - **Internal**: run `node <State CLI> map` first and read `.dev-cycle/map.md` before searching, then explore the codebase (use Glob, Grep, Read). At the end add or correct at most 10 lines under `## Notes` in that file, each in exactly this shape (glob in backticks, then a space, an em dash — not a hyphen, a space, the fact; lines in any other shape are ignored and never reach prompts): ``- `apps/api/**` — uses Fastify; tests via vitest`` (single line, up to 240 chars; durable orientation facts the generated part cannot show: conventions, legacy dirs, cross-package flow). Never edit above `## Notes`; never paste secrets or script bodies.
   - **Both**: do both, separated under H2 sections

2. Produce `discovery.md` in the feature folder. Sections:
   - `## Goal` — restate what we're trying to learn
   - `## Findings — External` (if applicable) — bulleted, with sources
   - `## Findings — Internal` (if applicable) — file paths, function names, key line ranges
   - `## Open questions` — anything the spec writer or implementer needs to resolve
   - `## Recommended approach` — one paragraph

3. Keep `discovery.md` under ~300 lines. If the answer is huge, link out instead of inlining.

## Output contract

```yaml
---
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: docs/features/<folder>/discovery.md
summary: <one sentence on the recommended approach>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```

Final message: the YAML block above plus at most 5 lines of prose (playbook core §6).
