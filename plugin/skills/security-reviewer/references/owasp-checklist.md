# OWASP Top-10 Diff Checklist

One-line prompts. For each changed file, ask:

## A01 — Broken Access Control
- Does this new endpoint / route / job have an auth check? If public, is that explicit?
- Are object IDs derived from user input checked against the caller's permissions (IDOR)?
- Are admin-only paths gated by role check, not just by being "unlinked"?

## A02 — Cryptographic Failures
- Any new use of `md5` / `sha1` for security? (Hashing passwords, signing tokens.)
- Are TLS-related flags being disabled or downgraded? (`rejectUnauthorized: false`, `verify=False`.)
- Are secrets read from env vars rather than committed?

## A03 — Injection
- Are new SQL queries parameterised (no string interpolation of user input)?
- Are shell commands using `exec` / `Runtime.exec` with user input unescaped?
- Are HTML strings built without proper escaping in templating?

## A04 — Insecure Design
- New auth flow without rate limiting? New file upload without size/type validation?

## A05 — Security Misconfiguration
- Are CORS origins newly opened to `*`?
- Are error responses leaking stack traces in production code paths?
- New env vars or config flags that disable security by default?

## A06 — Vulnerable Components
- (Heavy lifting belongs to this skill's dependency-audit section. Here only flag obviously deprecated APIs.)

## A07 — Authentication Failures
- Password handling without hashing? JWT signed with `none` or `HS256` + hard-coded secret?
- Session cookies missing `Secure` / `HttpOnly` / `SameSite`?

## A08 — Software & Data Integrity Failures
- Unsafe deserialisation of untrusted input (Python binary object loaders, Java `ObjectInputStream`, Ruby `Marshal.load`, `yaml.load` without `SafeLoader`)?
- New `<script>` tag pulling from a remote URL without SRI?

## A09 — Logging & Monitoring Failures
- New auth-relevant action with no audit log line?
- Sensitive data being logged (tokens, passwords, PII)?

## A10 — Server-Side Request Forgery
- New code making outbound HTTP from a user-supplied URL? Allowlist check?

## Output style

Each finding bullet: `[blocker|warning] path:line — A0N — <one-sentence issue>`. Only `blocker` causes CHANGES_REQUIRED.
