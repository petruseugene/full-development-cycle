# Common issues to call out

## Frontend
- Inline `style={{}}` for layout (use project styling)
- Network call in `useEffect` instead of query lib
- `<div onClick>` for buttons
- Hardcoded user-visible strings when i18n exists
- Stale closure due to bad deps array
- Large list without virtualization

## Backend
- SQL string concat
- Missing input validation at boundary
- Trusting client-supplied user ID
- 500 returned for client errors
- Outbound call without timeout
- Logging secrets / tokens
- N+1 query

## Tests
- Snapshot test for volatile UI
- Test asserts internal state, not behaviour
- Test mocks the thing under test
- Brittle selector (random class name)

## General
- Commented-out code
- Print/console statements left in
- Unused exports
- TODOs without a tracking link
