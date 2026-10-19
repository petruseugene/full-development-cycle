# Reversibility Checks

Every `up` operation needs a defined `down`. Map of operations:

## Reversible (auto-pair)

| Up | Down |
|---|---|
| `CREATE TABLE foo` | `DROP TABLE foo` |
| `ADD COLUMN foo.bar` | `DROP COLUMN foo.bar` |
| `CREATE INDEX idx_x` | `DROP INDEX idx_x` |
| `ADD CONSTRAINT …` | `DROP CONSTRAINT …` |
| `RENAME TABLE a TO b` | `RENAME TABLE b TO a` |
| `ALTER COLUMN … TYPE T2` (widening only) | `ALTER COLUMN … TYPE T1` |

## Data-loss in `down` — BLOCKER unless spec authorises

| Up | Why `down` loses data |
|---|---|
| `DROP TABLE foo` | recreating the table doesn't restore rows |
| `DROP COLUMN foo.bar` | dropped values can't be reconstructed |
| `ALTER COLUMN … TYPE T2` (narrowing — e.g. text → varchar(50)) | truncated data unrecoverable |
| `DELETE FROM foo WHERE …` | rows gone |
| `UPDATE foo SET bar = …` (overwriting) | original values lost |

For these, require an explicit `irreversible: true` flag in the task spec, and write the `down` as a no-op with a comment naming the spec line that authorised it.

## Constraints that need care

- `NOT NULL` added to an existing column requires a backfill in the same migration (or a prior one). The `down` is `DROP NOT NULL`, which is safe.
- `UNIQUE` added on existing data may fail on duplicates. Pre-check should run before adding the constraint.
- Foreign keys with `ON DELETE CASCADE` make deletion behaviour part of the schema — the `down` must restore the prior behaviour exactly.

## Tools that auto-generate

Some tools (Rails `change`, Ecto `change`, Alembic autogenerate) infer the `down` from the `up`. Trust them only after a manual scan — autogenerate misses data-loss cases.

## Output contract for this check

The `summary` field should name the change ("add NOT NULL to users.email"); the `concerns` field should list any operation marked `irreversible` for visibility.
