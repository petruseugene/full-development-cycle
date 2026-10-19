# Frontend best practices

## Components
- Default to function components. Hooks for state.
- One component per file. File name matches export name.
- Props are typed (TS) or PropTypes (JS). Document required vs optional.
- Components are pure — no side effects in render. Side effects in `useEffect` / equivalent.

## State
- Local state for local concerns. Lift only when needed.
- Server state belongs in a query library (TanStack Query / SWR / Apollo) — never raw `fetch` in `useEffect`.
- Form state belongs in a form library if the form has more than 2 fields.

## Styling
- Follow the project's existing approach. Don't introduce a new styling system.
- Layout via flex/grid, not absolute positioning, unless intentionally overlaying.
- Spacing on a scale (4px / 8px increments). Don't pixel-bash.
- Colors from a token / theme — never hardcoded hex values for theme-relevant colors.

## A11y
- Every interactive element is a `<button>` or `<a>`, not a `<div onClick>`.
- Every input has a `<label>`.
- Focus order matches visual order. Skip-to-content link on long pages.
- Minimum 4.5:1 contrast for body text.

## Async & errors
- Show loading, success, and error states. The "happy path with no loading state" is a bug.
- Errors are user-readable, not raw stack traces.
- Network errors offer retry where appropriate.

## Tests
- Test behaviour, not implementation. Avoid testing internal state.
- Use Testing Library queries by role / label, not by class / data-test-id (unless already established).
- One assertion per test concept. Multiple assertions OK if they describe one behaviour.
