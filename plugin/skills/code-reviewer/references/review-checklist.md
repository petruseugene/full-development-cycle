# Review checklist (universal)

Walk these in order. Each is a yes/no question.

## Acceptance & scope
- [ ] Does the diff satisfy the task's acceptance criteria?
- [ ] Is the diff scoped to this task only? (No drive-by refactors of unrelated code.)
- [ ] Does the build pass? (`npm run build` / equivalent.)
- [ ] Does the linter pass? (`npm run lint` / equivalent.)
- [ ] Do the tests pass, including any new ones?

## Correctness
- [ ] Are inputs validated at the boundary?
- [ ] Are errors handled (caught, translated, surfaced) — not swallowed?
- [ ] Are async ops properly awaited / sequenced?
- [ ] Are off-by-one / null / undefined / empty-array cases handled?

## Patterns & conventions
- [ ] Does the code follow patterns from neighbouring files (file naming, structure, exports)?
- [ ] Are new abstractions justified, or could existing ones be reused?
- [ ] Is the code DRY *only where DRY makes sense* (don't extract premature abstractions)?

## Best-practices (delegate to dev-skill references)
- [ ] Frontend tasks: walk `frontend-dev/references/pitfalls.md` — none triggered?
- [ ] Backend tasks: walk `backend-dev/references/pitfalls.md` — none triggered?

## Tests
- [ ] If `feature.json.auto_tests == true`, are tests added/updated?
- [ ] Do tests cover the happy path AND at least one error path?
- [ ] Do tests assert behaviour, not implementation?
- [ ] If `feature.json.tdd == true`, does the implementer report show RED→GREEN evidence (the `tdd:` block or the `TDD g/n` summary suffix)?
- [ ] More than 3 tests for one AC without a stated reason is over budget: a `nit` finding.

## Security & data
- [ ] No secrets / tokens / PII committed.
- [ ] No `console.log` / `print` of sensitive data.
- [ ] No raw SQL with concatenation; parameters only.
- [ ] No client-trusted identity.

## Style
- [ ] No commented-out code.
- [ ] No unused imports / variables / parameters.
- [ ] No TODOs without an owner / link.
- [ ] No giant comment blocks explaining what well-named code already says.
