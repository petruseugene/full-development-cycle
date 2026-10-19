# Task decomposition

## Rules

1. **One responsibility per task.** "Login API" and "Login form" are two tasks.
2. **End in a working state.** A task should leave the codebase compilable / runnable, not half-broken.
3. **Order by dependency.** Backend before frontend if frontend consumes backend. Schema before service. Service before handler.
4. **Group by file proximity.** Tasks editing the same file should be sequential, not interleaved with tasks elsewhere.
5. **Tag honestly.** `mixed` only when a single task genuinely spans both layers (e.g., adding an env var that both layers read). Most tasks are pure frontend or pure backend.

## Anti-patterns

- "Implement everything for module X" (too big — break into 3-6 tasks)
- "Refactor X" with no observable end state (what does success look like?)
- "Add tests" as a separate task (tests live with the task that adds the code, not after)
- A 50-step task list that's really 5 tasks with 10 steps each

## Declaring `Touches:` globs

Every task must carry a `**Touches:**` line — a best-effort glob list of files the implementer will write to. The orchestrator uses this to compute parallel groups (tasks with mutually-disjoint `Touches` can run in parallel within a tier). Bad estimates cause collisions; good estimates unlock parallelism.

**Rules:**

1. **Prefer narrow over broad.** `api/posts/**` is good. `api/**` is too broad and will collide with every other backend task. If you genuinely don't know the path, write the narrowest plausible glob and accept that the implementer may need to expand via `touches_expanded:` in its YAML report.
2. **List shared files explicitly.** `package.json`, `tsconfig.json`, `pyproject.toml`, `Cargo.toml`, shared type modules (e.g., `api/types.ts`, `src/types/index.ts`), shared route registries, shared style tokens — if a task will touch any of these, list them by exact path, not under a wildcard. This is the only way the orchestrator can detect that two tasks both edit the same shared file and must serialize.
3. **Use `**` only when the implementer truly owns a whole subtree.** Component folders, feature slices, migration directories — yes. Top-level `src/**` or repo-wide `**/*.ts` — never.
4. **Migrations are their own task.** Don't co-list `db/migrations/**` on a feature task that also touches handlers — that's a sign the migration should be a separate task per the rules above.
5. **Globs are paths, not patterns of intent.** `**/*.test.ts` is the wrong shape — tests live with the code they cover, so the test files fall under the same glob as the source.

**Examples:**

| Task                                  | Good `Touches:`                                            | Bad `Touches:`         |
|---------------------------------------|------------------------------------------------------------|------------------------|
| Add posts API endpoint                | `api/posts/**`, `api/types.ts`                             | `api/**`               |
| Add posts list component              | `src/features/posts/**`, `src/types/index.ts`              | `src/**`               |
| Add `RATE_LIMIT` env var to both layers | `api/config.ts`, `src/config.ts`, `.env.example`, `README.md` | `**/config*`        |
| Initial DB migration for posts        | `db/migrations/**`, `db/schema.sql`                        | `db/**`                |

## Size

Optional per-task field `**Size:** S|M|L`, placed after `**Depends on:**`. A missing Size means `M`. Size is informational only: it never changes the model an implementer runs on. Mark a task `L` when it is a hard, cross-cutting, or high-risk change (e.g. a new core abstraction or a tricky migration of existing behaviour), not merely a long one.

## Declaring `Depends on:`

A list of prerequisite task IDs whose output this task reads (types, schemas, generated clients, components imported, endpoints called). Use `none` when no dependency exists.

- `Depends on:` is **asymmetric** — it defines ordering only, not file overlap. Two tasks can `Depends on: none` and still be unable to run in parallel because their `Touches:` overlap.
- Keep the chain shallow. If Task 5 depends on 1, 2, 3, 4, ask whether 1–4 could be collapsed into a single foundation task.
- A task that depends on another task's **types** but not its runtime behavior still depends on it — the type file must exist before the consumer can import it.
