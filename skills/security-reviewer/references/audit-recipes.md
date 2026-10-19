# Audit Recipes

## npm / yarn / pnpm

```bash
npm audit --omit=dev --audit-level=high --json
# yarn ≥ 2: yarn npm audit --severity high --recursive --json
# pnpm:     pnpm audit --prod --audit-level high --json
```

- `--omit=dev` (or `--prod`) — exclude devDependencies; lower noise. Override only if the feature explicitly ships dev tools.
- `--audit-level=high` — controls which advisories cause a non-zero exit.
- Parse `metadata.vulnerabilities.{critical,high}` for the counts; iterate `vulnerabilities` for per-package detail.

## Python

```bash
pip-audit --strict --format json
# poetry: poetry export -f requirements.txt --without-hashes | pip-audit -r /dev/stdin --format json
```

- `--strict` — exit non-zero on any finding (then filter by severity in the parser).
- For `uv` / Python 3.12+: `uv pip compile` then `pip-audit`.

## Rust

```bash
cargo audit --json
```

- Reads `Cargo.lock`; advisories from `rustsec.org`.
- Severity in `vulnerabilities[].advisory.severity`.

## Go

```bash
govulncheck -json ./...
```

- Reports both module-level advisories AND call-graph reachability — prefer reachable findings as blockers.

## Severity threshold

Default `high` (= "high" and "critical"). Override via `feature.json.dependency_audit_threshold` ∈ { `low`, `moderate`, `high`, `critical` }.

## When a tool is not installed

Bullet `[skip] <tool> — not installed` and continue. Do not fail the run on a missing optional tool. If *no* audit tool is available for the detected ecosystem, return `NEEDS_CONTEXT`.

## License extraction

- npm: `npm ls --omit=dev --json` then map each dep to its `license` field.
- Python: `pip-licenses --format=json`.
- Rust: `cargo license --json`.
- Go: `go-licenses report ./...`.

## pnpm / mobile (Expo / React Native)

Active pnpm audit (the `pnpm:` line in the npm / yarn / pnpm block above is a comment and stays as is):

```bash
pnpm audit --prod --audit-level high --json
# pnpm-workspace.yaml present, run from the workspace root:
pnpm audit --prod --audit-level high --json --recursive
```

- `--recursive` is only for monorepos; without `pnpm-workspace.yaml`, run the plain form. Parse the JSON as in the npm recipe. Unverified: whether your pnpm version needs `--recursive` or already audits the whole workspace from the root. Check `pnpm audit --help`.
- Network failure or registry error: bullet `[skip] pnpm audit — network unavailable` and continue.

### Expo SDK compatibility (when `expo` is in dependencies)

```bash
npx expo install --check
```

- Read-only report of installed packages that differ from the versions the current Expo SDK expects. Run it from the app package directory.
- Never run `npx expo install --fix` or `--check` with an auto-fix prompt. Those mutate `package.json` and the lockfile, which this skill must not do.
- Report each mismatch as a **warning** (SDK-compat), not a vulnerability. Warnings never change the PASSED / FAILED status and do not count toward the severity threshold.
- Needs network access. On failure, bullet `[skip] expo install --check — network unavailable`.
