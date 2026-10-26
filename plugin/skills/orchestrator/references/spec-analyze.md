# Spec analyze and amendments (tracks `full` and `lite`)

`node <CLI> spec analyze [--json] --feature <f>` is read-only. It checks spec.md ACs, the tasks source and `test-report.md`. Errors exit 1, warnings never change the exit code.

## When to run

- Track full: after plan-writer.
- Combined mode and lite: after the decisions step is empty (`open-decisions.md`).
- Always before `git branch` and the first implementer.
- Again after every amendment.

## On errors

- exit 1: re-dispatch plan-writer for task errors (`unknown-ac`, `superseded-ref`) or spec-writer for spec errors (`duplicate-ac`, `bad-marker`, `missing-target`, `supersede-cycle`), passing the output.
- After 3 rounds still failing: `feature set status blocked` and escalate with the output.
- Exit 2 (missing spec.md, malformed tasks): fix the input via the writer and re-run.
- Warnings (`ac-no-task`, `task-no-ac`, `superseded-ref-done`, `ac-no-test`, `ac-unscoped`): relay them in one line. They never block.

## Amendment flow

Owner change request on an in-flight full or lite feature:

1. Re-dispatch spec-writer with a block `Amendment:` containing the owner request verbatim. spec-writer runs `spec amend` (`--title`, then `--supersede` per replaced AC) and writes the new ACs.
2. Full track: re-dispatch plan-writer to append tasks for the new ACs.
3. Run `spec analyze` (above), then implement.

Rules: never hand-edit spec.md; the CLI writes the heading and markers, spec-writer writes the AC text.

## Exemptions and backstop

- Quick track, flows bugfix and hotfix have no spec.md and skip all of this.
- `dod` fails with `! DOD-GATE FAILED: spec-analyze last status = ERRORS; aborting before push.` as a backstop (`dod-gate.md`); do not rely on it.
- Follow-up, not shipped: the dashboard does not read the supersede marker yet.
