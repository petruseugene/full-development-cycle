# Migrations (read when an AC or the Touches mention schema, table, column, index or migration)

Scope is the migration file(s) for the current task. Migrations stay their own task; do not mix schema changes into a feature task. Skip when no migration directory is detected (handle inline DDL if any).

1. **Detect the migration directory** by probing in order: `migrations/`, `db/migrate/`, `alembic/versions/`, `prisma/migrations/`, `supabase/migrations/`, `sql/migrations/`, `priv/repo/migrations/`. Also probe `drizzle/` (Drizzle; expo-sqlite bundles `drizzle/migrations.js`).
2. **Match the project's convention** for naming, numbering (sequential vs timestamp) and language (SQL vs DSL).
3. **Author or validate** the migration file(s). Honour existing helper macros (Rails `change`, Alembic `op.batch_alter_table`).
4. **Reversibility check** per `reversibility-checks.md`. Data loss in `down` is a BLOCKER unless the task's acceptance criteria explicitly say "irreversible". For Supabase SQL and Drizzle/expo-sqlite (forward-only) follow `mobile-migrations.md`: a missing `down` is fine; run its compatibility and RLS checks instead.
5. **Zero-downtime check** per `zero-downtime-patterns.md` for non-trivial changes on live tables (expand, migrate, contract; backfill batching; lock avoidance).
6. Stage, do not commit. Return `BLOCKED` (with `blocker:`) on irreversibility; `DONE_WITH_CONCERNS` if zero-downtime caveats remain; `DONE` otherwise. Set `output_file` to the migration file path.
