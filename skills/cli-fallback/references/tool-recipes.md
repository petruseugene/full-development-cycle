# Tool Recipes — cli-fallback

All recipes are **read-only**. If a tool defaults to mutating (e.g. `prettier --write`), pass the check-only flag instead.

## JavaScript / TypeScript

| Tool | Command | Notes |
|---|---|---|
| ESLint | `npm run lint` (preferred) or `npx eslint . --max-warnings=0` | Use the project's script if it exists. |
| TypeScript | `npx tsc --noEmit` | Add `-p tsconfig.json` if non-default. |
| Prettier | `npx prettier --check .` | Honour `.prettierignore`. |
| Biome | `npx biome check .` | Replaces ESLint+Prettier in some repos. |

## Python

| Tool | Command | Notes |
|---|---|---|
| Ruff | `ruff check .` | Includes flake8 + isort + many pyupgrade rules. |
| Mypy | `mypy .` | Use `--strict` only if project config does. |
| Black | `black --check .` | Read-only flag. |
| Flake8 | `flake8` | Only if Ruff is not configured. |

## Go

| Tool | Command |
|---|---|
| Vet | `go vet ./...` |
| Format | `test -z "$(gofmt -l .)"` (exits non-zero if any file would change) |
| Staticcheck | `staticcheck ./...` (if available) |

## Rust

| Tool | Command |
|---|---|
| Clippy | `cargo clippy --all-targets -- -D warnings` |
| Format | `cargo fmt --all -- --check` |

## scope=touched variants

When `dev-cycle:cli-fallback` is invoked with `scope=touched`, adapt the base commands above as follows:

| Language | scope=touched command | Notes |
|---|---|---|
| JS/TS | `eslint <globs>`, `tsc --noEmit`, `prettier --check <globs>` | `tsc --noEmit` stays project-wide even in touched mode — narrowing it breaks the type graph and produces false negatives/positives. |
| Python | Same tools as the base table (`ruff check`, `mypy`, `black --check`) | Append the touched-file globs as positional args to each command. |
| Go | `go vet ./<pkg>...`, `gofmt -l <files>` | Scope both vet and gofmt to the touched package(s)/files. |
| Rust | `cargo clippy -p <crate>` if the touched globs map to a single crate | Otherwise fall back to whole-workspace `cargo clippy` — there's no reliable way to scope clippy across multiple crates in one invocation. |

## Exit code handling

- Tool exit 0 → bullet `[pass] <tool>`.
- Non-zero → bullet `[fail] <tool> — <first error line>`. Truncate to a single, useful line — full output stays in the tool's own logs, not in `test-report.md`.
- Tool not installed → bullet `[skip] <tool> — not installed` and continue. Do not fail the run on a missing optional tool; only fail when a *configured* tool reports errors.

## pnpm workspace (when `pnpm-workspace.yaml` exists)

| Scope | Command | Notes |
|---|---|---|
| tree-wide lint | `pnpm -r --if-present lint` | Skips packages without a `lint` script. |
| tree-wide typecheck | `pnpm -r --if-present typecheck` | Preferred when packages define a `typecheck` script. Otherwise run `pnpm -F <pkg> exec tsc --noEmit` only for packages containing a `tsconfig.json`; never `pnpm -r exec tsc` (it runs in every package, and tsc without a tsconfig prints help and exits non-zero, a false `[fail]`). |
| scope=touched | `pnpm -F <pkg> lint`, `pnpm -F <pkg> exec tsc --noEmit` | Map each touched glob to its owning package; run only those packages. |

## Expo (when `expo` is a dependency)

Run from the app package directory. If `expo:*` skills are available, invoke `expo:expo-overview` first, then the specific `expo:*` skill for any finding. If not installed, see https://docs.expo.dev; the commands below are the minimum.

| Tool | Command | Notes |
|---|---|---|
| Expo lint | `npx expo lint` | Run only when an `eslint.config.*` or `.eslintrc*` already exists in the app package; otherwise report `[skip] expo lint — no ESLint config`. Without a config it bootstraps ESLint (installs deps, creates config), breaking read-only. Skip if a `lint` script exists (the generic `scripts.lint` recipe already covers it). |
| Expo Doctor | `npx expo-doctor` | Separate package; needs network for some checks. |
| SDK compatibility | `npx expo install --check` | Report only; needs network. |

- `--fix` is never used (neither `npx expo lint --fix` nor `npx expo install --fix`); the checker is read-only.
- A network failure in `expo-doctor` or `expo install --check` is reported as `[skip] <tool> — network unavailable`, not `[fail]`.
