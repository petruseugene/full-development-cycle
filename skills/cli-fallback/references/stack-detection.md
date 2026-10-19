# Stack Detection — cli-fallback

Mirror the probing pattern already used by `dev-cycle:frontend-dev` and `dev-cycle:backend-dev`. The goal is a small, deterministic decision tree, not a perfect identifier.

## Profile commands (take precedence)

If `.dev-cycle/project.json` exists with `commands.lint`, `commands.typecheck` or `commands.format`, run those instead of the detected tool for that step. Fall back to the probes below only for steps the profile leaves unset.

## Order of probes

1. **`package.json`**
   - If `scripts.lint` exists → run it.
   - If `tsconfig.json` is also present → add `tsc --noEmit`.
   - If `.prettierrc*` or `prettier` is a dependency → add `prettier --check .`.
2. **`pyproject.toml` / `setup.cfg` / `requirements*.txt`**
   - If `ruff` is configured (in `pyproject.toml` under `[tool.ruff]` or `ruff.toml`) → `ruff check .`.
   - If `mypy.ini` / `[tool.mypy]` → `mypy .`.
   - If `black` is configured → `black --check .`.
   - If only `flake8` is present → `flake8`.
3. **`go.mod`** → `go vet ./...` and `gofmt -l .`.
4. **`Cargo.toml`** → `cargo clippy -- -D warnings` and `cargo fmt --check`.
5. **Other**: if no recognised stack, return `NEEDS_CONTEXT` with a one-line explanation.

## Notes

- Always honour an existing `scripts.lint` (or pyproject `[tool.poe]` / `make lint` target) over reconstructing one — the project's authors made that choice.
- If both a "fast" and a "strict" lint script exist (e.g. `lint` vs `lint:ci`), prefer the strict one for this check.
- Treat absence of typechecker config as "no typecheck step", not an error.

## Mobile / monorepo probes

- **`pnpm-workspace.yaml`** present → pnpm workspace. Use the pnpm workspace recipes in `tool-recipes.md` instead of a single root `npm run lint`.
- **`expo` in `dependencies`** of a `package.json` (root or a workspace package) → Expo app. Add the Expo recipes in `tool-recipes.md`, run from that app package directory.
- Expo / React Native: if `expo:*` skills are available, invoke `expo:expo-overview` first, then `expo:expo-router` or the skill matching the finding. If they are not installed, see https://docs.expo.dev and use the minimum commands: `npx expo lint`, `npx expo-doctor`, `npx expo install --check`.
