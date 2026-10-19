# Routing edge cases

## NEEDS_CONTEXT

Subagent reports `NEEDS_CONTEXT` with `needed_context: <description>`. Action:
1. Read the requested artefact path from disk (only what was requested).
2. Re-dispatch the same subagent with the artefact's contents inlined into the prompt.
3. If the second dispatch also returns `NEEDS_CONTEXT`, escalate to user — do not loop.

## BLOCKED on first dispatch

Subagent reports `BLOCKED` immediately with `blocker: <text>`. Action:
- Mark task `[BLOCKED]` with `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs task <n> status BLOCKED` (or, for a pre-task phase, `dev-cycle.mjs feature set status blocked`).
- Stop dispatching. Print the blocker to the user with concrete recovery hints.
- Do not retry on user's behalf — wait for user input.

## CHANGES_REQUIRED with empty findings

Reviewer reports `CHANGES_REQUIRED` but `findings_count: 0`. Action:
- Treat as malformed report. Re-dispatch reviewer once with explicit reminder of the contract.
- If still malformed, escalate.

## Test FAILED but reviewer APPROVED

Sequence: reviewer APPROVED a task, then tester FAILED on the same task. Action:
- Re-dispatch implementer with `test-report.md` path. Do NOT re-run reviewer until tester passes.
- After implementer fixes, dispatch tester again. Once tester PASSED, dispatch reviewer for a re-check on the new diff.

## Visual-test FAILED: which task to rewind

On `dev-cycle:visual-tester` FAILED, the rewind target is the task most likely responsible per the breadcrumb in `test-report.md`; escalate if unknown (orchestrator does not guess). Re-dispatch that single task's implementer; counts against the per-task 3-cycle limit.

## Extra-gate (`gate.<name>`) FAILED

Route by the file paths named in `gates/<name>.log`, using the glob-overlap
rule in `collision-and-fix-routing.md`; if no path is named or none overlaps
a task's `Touches`, escalate to the user.

## Implementer wrote nothing

Implementer reports `DONE` but `git diff` shows no changes. Action:
- Treat as failure. Mark task `[BLOCKED]` via `dev-cycle.mjs task <n> status BLOCKED`. Escalate with: "implementer reported DONE but produced no diff — likely misunderstood the task."

## Three fix cycles exhausted

After 3 implementer↔reviewer (or implementer↔tester) cycles on the same task:
- Mark task `[BLOCKED]` via `dev-cycle.mjs task <n> status BLOCKED`.
- Escalate with: review/test feedback from cycle 3, recommendation to either rescope the task or fix manually.

## User interrupts mid-feature

If user sends a message during a phase, complete the current dispatch (don't kill it), then surface the user's message and pause for direction. `feature.json` is the resume point.
