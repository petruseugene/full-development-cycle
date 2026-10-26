---
description: Drive a feature or bugfix end-to-end — interview, discovery, spec, plan, parallel implementation, review gates, tests, PR.
argument-hint: <feature or bug description>
---

Invoke the `dev-cycle:orchestrator` skill for the following request:

$ARGUMENTS

Rules:
- Run the feature-start interview before dispatching anything (the track is chosen automatically, never asked).
- All artefacts go under `docs/features/` of the current project.
- Never write feature code yourself — dispatch every phase as a subagent.
- The state CLI (`scripts/dev-cycle.mjs`) owns every state change — feature folder, status flips, `feature.json` keys (`feature set`), history, totals, DoD gate, static checks (`check`), shipping (`ship`, or `git branch|commit|push|pr|merge`) and measured tokens (`tokens`). Dispatch `dev-cycle:cli-fallback` only for the documented failure reasons; never dispatch a skill listed in `feature.json.skipped_skills`. Never hand-edit `feature.json`, `plan.md` or `spec.md` (tasks live in spec.md when `separate_plan=false`).
