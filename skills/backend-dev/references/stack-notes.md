# Stack-specific notes

## Node + Express / Fastify
- Routers per resource. One file per route group.
- Middleware composition for auth, logging, validation.
- ORM: follow project's existing one (Prisma, Drizzle, TypeORM, Sequelize, Knex). Don't introduce a new one.

## Node + Next.js Route Handlers
- `route.ts` per endpoint. Use `NextRequest` / `NextResponse`.
- Don't put server logic in components; use Route Handlers or Server Actions.

## Python + FastAPI
- Pydantic models for request/response. Dependency injection via `Depends`.
- Async views unless something blocks the loop. SQLAlchemy 2.x async session.

## Python + Django
- Use the existing app structure. Forms or DRF serializers per project convention.
- Migrations are sacred — never edit applied ones.

## Go
- Standard library `net/http` + `chi`/`gorilla` (per project). Handlers return errors; middleware translates to status.
- Context propagation everywhere. Cancel on request close.

## Rust + Axum / Actix
- Errors implement `IntoResponse`. Strong typing for state via `State<T>`.

## Auth — common patterns
- JWT: validate signature + exp; treat as opaque.
- Session cookies: HttpOnly, Secure, SameSite=Lax (or Strict for sensitive).
- Hashing: argon2id is preferred; bcrypt acceptable.

## Supabase (Postgres + Edge Functions, Deno)
Detected by `supabase/config.toml`. Edge Functions run on the Supabase Edge Runtime (Deno-compatible, TypeScript-first, `npm:` specifiers supported).
- Functions: `supabase functions new <name>`, `supabase functions serve` (local), `supabase functions deploy <name>`. The JWT is verified by default.
- Authz is RLS-first: every table in an exposed schema needs RLS enabled plus explicit policies. A table without RLS is world-readable via the `anon` key. Check with `supabase db lint` or the Security Advisor (`rls_disabled_in_public`).
- Types: generate into a shared workspace package, not an app: `supabase gen types --lang typescript --local > packages/<shared>/src/database.types.ts` (or `--linked` / `--project-id <id>`). Regenerate after every migration.
- Storage: serve private files through signed URLs (short expiry), not public buckets; enforce access with Storage RLS policies.
- Secrets: `supabase secrets set NAME=value`; never commit them or hardcode them in function code.
- Webhooks: provider-called functions (no user JWT) are deployed with `--no-verify-jwt`. This must be paired with mandatory signature verification of the request (HMAC or provider SDK check on the raw body) before any work; reject on failure.
- Migrations are forward-only SQL; keep them compatible with every shipped app version.
