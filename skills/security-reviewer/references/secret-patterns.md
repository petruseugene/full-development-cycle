# Secret Patterns

Diff-scan the added lines for these. False positives are fine — flag as `warning`, escalate to `blocker` only if the value is clearly not a placeholder.

## High-signal regexes

| Category | Pattern (perl-style) | Example trigger |
|---|---|---|
| AWS access key | `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` |
| AWS secret | `(?i)aws_secret.{0,20}['\"][A-Za-z0-9/+=]{40}['\"]` | env var assignment |
| GitHub token | `gh[pousr]_[A-Za-z0-9]{36,}` | `ghp_…` |
| Google API key | `AIza[0-9A-Za-z\-_]{35}` | |
| Slack token | `xox[bpoa]-[0-9]{10,}-[0-9A-Za-z-]+` | |
| Stripe live | `sk_live_[0-9a-zA-Z]{24,}` | |
| Private key | `-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----` | |
| JWT | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | usually fine in tests |
| Generic high-entropy | string ≥ 32 chars, mixed case + digits, in a string literal assigned to a name containing `secret`/`token`/`password`/`key` | requires judgement |

## Heuristic checks

- Hard-coded URLs containing `://user:password@` — credentials in URL.
- `.env` / `.env.production` being added to git (not just `.env.example`).
- Database connection strings with literal passwords.
- Plain-text password fields in test fixtures that look real (length > 12, mixed entropy).

## What is NOT a secret

- Public API endpoints, client-side identifiers like Sentry DSN public keys, Stripe publishable keys (`pk_test_…`, `pk_live_…`), Google Maps client keys.
- Anything inside a `.example` / `.template` file.
- UUIDs that are clearly test data.

## When in doubt

Flag as `[warning] path:line — A02 — possible secret, please confirm`. Let the reviewer assess in context.
