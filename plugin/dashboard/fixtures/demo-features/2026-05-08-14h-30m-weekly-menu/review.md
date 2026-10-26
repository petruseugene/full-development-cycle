# Code review log — Weekly Menu

## Task 4 · cycle 1 — CHANGES_REQUIRED
- L42: Prefer `useDrag` hook returning a cleanup function rather than imperative listeners.
- L88: Memo dependency on `recipes` is missing — will re-run on every render.

## Task 4 · cycle 2 — CHANGES_REQUIRED
- L91: Cancel branch still mutates the source-day array; use a snapshot.

## Task 6 · cycle 1 — CHANGES_REQUIRED
- L18: Aggregation does not normalize units (cups vs grams).

## Task 6 · cycle 2 — CHANGES_REQUIRED
- L20: Same finding — unit normalization still missing.

## Task 6 · cycle 3 — CHANGES_REQUIRED
- L20: Unit normalization missing. Escalating: needs human decision on unit policy.
