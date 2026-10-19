# Zero-Downtime Patterns

For migrations on tables in production use. If the project doesn't run production from main, these are nice-to-have; if it does, they're hard requirements.

## The two failure modes

1. **Long locks** — `ALTER TABLE` blocks reads/writes for the duration of the rewrite.
2. **Schema/code skew** — old app pods talk to the new schema (or vice-versa) and crash on missing columns / wrong types.

## Expand → migrate → contract

The canonical pattern. Each step is its own migration + deploy:

1. **Expand**: add the new column / table / index. Old code still works (it ignores the new shape).
2. **Migrate**: dual-write in app code (both old and new column updated); backfill historical rows.
3. **Contract**: drop the old column / table after the dual-write deploy is stable.

A migration task should produce **one of these steps**, not all three. If the task asks for the full sequence in one migration, split it (NEEDS_CONTEXT or DONE_WITH_CONCERNS).

## Backfill batching

Never `UPDATE foo SET …` on a large table in a single statement.

- Batch by primary key range, 1k–10k rows at a time, with a small sleep / yield.
- Use `WHERE foo.new_col IS NULL` as the predicate so the job is resumable.
- For ORM users: use the framework's batch helper (Rails `find_each`, Django `Paginator`, Alembic `op.execute` with chunked SQL).

## Lock-avoidance per engine

| Engine | Avoid | Prefer |
|---|---|---|
| Postgres | `ALTER TABLE … ADD COLUMN … DEFAULT non-null` (rewrites table on < 11) | Add nullable, backfill, then set default + NOT NULL |
| Postgres | `CREATE INDEX` (blocks writes) | `CREATE INDEX CONCURRENTLY` (cannot run in transaction) |
| MySQL | `ALTER TABLE … ALGORITHM=COPY` | `ALGORITHM=INPLACE, LOCK=NONE` where supported; pt-online-schema-change otherwise |
| SQLite | almost everything | Recreate-table pattern (the migration tool usually does this) |

## When NOT to bother

- The table is small (≤ 10k rows) and writes are infrequent.
- The migration runs during an announced maintenance window.

Document the choice in the `concerns` field if you skip the pattern intentionally.
