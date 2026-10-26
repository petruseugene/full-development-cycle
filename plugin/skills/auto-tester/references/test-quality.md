# Test quality rules

## Each test
- Has a name that reads like a sentence: "login throws InvalidCredentials when password mismatches".
- Tests one thing. Multiple assertions OK if they describe one behaviour.
- Sets up its own state (no test depends on prior test's mutation).
- Cleans up after itself (or uses a framework cleanup hook).

## Avoid
- Snapshot tests for anything that changes often.
- Tests that assert "function was called" when you can assert "result is correct" instead.
- Sleeps / arbitrary timeouts. Use proper async helpers (waitFor / awaiting promises).

## Naming
- `<unit>.test.<ext>` colocated with `<unit>` (or under `__tests__/`) per project convention.
- Test name describes behaviour, not implementation.
