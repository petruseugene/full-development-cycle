# Severity guide

## Blocker (must fix before APPROVED)
- Test failures, build failures, lint failures
- Security issues (injection, secret leak, auth bypass)
- Missing AC: the feature literally doesn't do what was asked
- Crash paths: null deref, unhandled promise rejection, infinite loop
- Data correctness: wrong update, missing transaction, race condition
- Public API contract violations

## Nit (note but don't block APPROVED)
- Code style nits (spacing, naming) that aren't covered by lint
- Suboptimal patterns that don't break behaviour
- Missing edge-case test (when happy path + one error are tested)
- Comments that explain *what* instead of *why*
- Slightly larger files than convention

Severity vocabulary in `review.md` is exactly `blocker` or `nit` — no other labels.

## Don't mention at all
- Personal preferences not backed by a project convention
- Opportunities for unrelated refactors
- Speculative future-proofing ("you might need this when…")

## When in doubt
Re-read the task's acceptance criteria. If the diff satisfies them and has no blocker, lean APPROVED.
