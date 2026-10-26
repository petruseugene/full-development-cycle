# Backend pitfalls (don't do these)

## Errors
- Returning 500 for client errors. 400 / 401 / 403 / 404 / 409 / 422 exist for reasons.
- Echoing internal exception strings into HTTP responses.
- Empty `catch` blocks.

## DB
- Building SQL with string concatenation. Use parameterized queries.
- Holding a transaction across a network call.
- Reading the whole table to count / filter in app memory.

## Auth
- Trusting `userId` from the request body.
- Authorization decisions in middleware that doesn't have full context.
- Storing passwords without a strong KDF (bcrypt / argon2). Never plain or fast hashes.

## Validation
- Trusting the client. Re-validate everything server-side.
- Using regex for email/URL when a real validator exists.

## Async
- `fetch`/HTTP without a timeout.
- Background jobs that aren't idempotent.
- Fire-and-forget promises in serverless handlers — they get killed when the request ends.

## Logging
- Logging secrets / tokens / PII.
- Logging at INFO for things that happen 1000×/sec.

## Tests
- Mocking the DB in integration tests when it's the integration that matters.
- Tests that depend on external network without a flag.
- Test fixtures that mutate shared state across tests.
