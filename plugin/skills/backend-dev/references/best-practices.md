# Backend best practices

## Layering
- Handler → service → repository (or equivalent). Don't query the DB from a handler.
- Each layer has a single concern. Handlers parse + auth; services orchestrate; repos persist.
- Inject dependencies — don't `import` a singleton DB client into a service.

## Errors
- Domain errors are typed (custom error classes / Result types). Don't throw strings.
- Catch at the boundary (handler), translate to HTTP status. Never let an internal error type leak in the response body.
- Log at the catch site with structured fields (correlation ID, user ID if known).

## Validation
- Validate at the system boundary. Use a schema validator (zod / pydantic / joi / go-validator).
- Fail fast on bad input — 400 with a useful message, not 500.

## Auth
- Authentication and authorization are different. Always check both.
- Authorization checks happen at the service layer (or before), so they're testable in isolation.
- Never trust the client for identity — always derive from a verified session/token.

## Database
- Transactions for multi-step writes that must be atomic.
- Indices for queries used in hot paths. EXPLAIN before assuming an index works.
- N+1 queries are bugs — use joins or batched loaders.
- Migrations are forward-only and reviewable independently.

## Async & timeouts
- Every outbound call has a timeout.
- Every long-running job is idempotent (safe to retry).
- Background tasks have observability — log start, end, duration, success/failure.

## Tests
- Unit-test services in isolation with mocked repos.
- Integration-test handlers against a real DB (per `feature.json.auto_tests`).
- Don't test framework code (the framework is tested upstream).
