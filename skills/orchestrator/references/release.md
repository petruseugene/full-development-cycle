# Release notes and version bump

Release is done by the CLI, not by hand: `node <CLI> ship --release patch|minor|major|auto [--notes-file <f>] [--manifest <path>]...`. `ship` bumps the manifest version(s) and inserts the `CHANGELOG.md` section inside the one feature commit, before the PR is opened, and tags `v<x.y.z>` on the merge commit after the merge. There is no separate release commit and the orchestrator never edits a manifest or `CHANGELOG.md` itself; doing so double-bumps the version.

Release is skipped (omit `--release`) when `feature.json.release_manage == false`, when the repo has no version manifest, or for the `bugfix` flow unless `release_manage == true` is set explicitly. If `ship` prints `ship release: FAILED <reason> — <detail>` (for example `no-manifest`, `version-mismatch`, `invalid-version`), surface it to the user; do not bump by hand.

## What the orchestrator does

1. Pick the level: `--release major|minor|patch`, or `--release auto` to let `ship` infer it from the commit `--subject` and `--body` (so pass `--subject`, and the `--body` carrying any `BREAKING CHANGE:` footer). `--release` needs `--subject` or `--notes-file`.
2. Write the notes to a file (inside the project or the temp dir, at most 64 KB) and pass `--notes-file <f>`: the Keep-a-Changelog body only (`### Added` etc., see below), without the version heading. Without `--notes-file`, `ship` writes a single bullet from the subject.
3. For `platform == "mobile"`, follow the Expo section and state `OTA-safe` or `native-build-required` in the orchestrator's summary.
4. In a monorepo pass `--manifest <path>` (repeatable) for only the packages whose paths appear in the diff. Without it `ship` bumps every root manifest that has a version, and they must all agree.

What `ship` edits: the first existing of `.claude-plugin/plugin.json`, `package.json` (`version`), `app.json` (`expo.version`), `pyproject.toml` (`[project].version` or `[tool.poetry].version`), `Cargo.toml` (`[package].version`). `--manifest` accepts only those file names, inside the project root. The version must be `x.y.z`.

## Semver rules

Conventional Commits to semver level. With `--release auto`, `ship` scans the subject and body it was given (plus any commits already on the branch) and uses the highest level that any message triggers.

| Commit shape | Level |
|---|---|
| `BREAKING CHANGE:` at the start of a body line OR `!` after type/scope (e.g. `feat!:`, `refactor(api)!:`) | **major** |
| anything else (`feat`, `fix`, `perf`, `chore`, `docs`, `refactor`, `test`, `style`, `build`, `ci`, unparseable) | **patch** |

`auto` never picks **minor** outside 0.x: small features bump the third number. Pass `--release minor` explicitly for a minor bump.

### 0.x.y special case

While the major version is `0`:
- `BREAKING CHANGE` / `!` bumps **minor**, never major.
- `feat:` bumps **patch**, as on 1.x (pass `--release minor` explicitly for a minor bump).
- everything else bumps **patch**.

### Examples

| Messages | Old to New |
|---|---|
| `feat: add login`, `fix: typo` | 1.2.3 to 1.2.4 |
| `feat!: rename API`, `fix: ...` | 1.2.3 to 2.0.0 |
| `chore: bump deps` | 1.2.3 to 1.2.4 |
| `feat: add login` (on 0.x) | 0.3.1 to 0.3.2 |
| `fix: typo` (on 0.x) | 0.4.2 to 0.4.3 |
| `feat!: drop ABC` (on 0.x) | 0.4.2 to 0.5.0 |
| `refactor: ...`, `docs: ...` | 1.2.3 to 1.2.4 |

`ship` records the bump in `feature.json` history as phase `release`, summary `<old> → <new>`; re-running skips a release already recorded for the current version.

## CHANGELOG style (Keep a Changelog)

Reference: https://keepachangelog.com/

### Notes file body (what you write for `--notes-file`)

```markdown
### Added
- Email + password login flow for end users.

### Changed
- `/auth/refresh` now returns a 7-day refresh token (was 24h).

### Fixed
- Password-reset link expiring after 1 minute.

### Removed
- Deprecated `/api/v1/login` endpoint.
```

No version heading: `ship` adds `## [<version>] - YYYY-MM-DD` (today) itself.

### Resulting file layout

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

## [1.3.0] - 2026-05-11

### Added
- ...
```

### Rules

- `ship` turns an existing first `## [Unreleased]` heading into the version heading (its old body stays under the new section); otherwise it inserts the section before the first `## ` heading. A missing `CHANGELOG.md` is created with a `# Changelog` header.
- Subsections only when there is content: `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`. Order them as listed.
- One bullet per user-visible change. Combine related commits if they map to the same outcome.
- Voice: present tense, user-facing. "Add email login" not "Added email login functionality for the auth subsystem to support new login flow."
- Skip purely internal commits (chore / refactor / docs / test / build / ci) unless they have a user-observable impact.

### Mapping commits to sections

| Commit type | Section |
|---|---|
| `feat:` | Added |
| `fix:` | Fixed |
| `perf:` | Changed |
| `refactor:` (with `BREAKING CHANGE`) | Changed |
| `feat!` / `refactor!` / `BREAKING CHANGE` | Changed or Removed (whichever fits) |
| `chore: deprecate X` / mentions "deprecate" | Deprecated |
| commits tagged `[security]` or `fix: CVE-…` | Security |

Compare links in the footer (`[1.3.0]: https://…/compare/v1.2.3...v1.3.0`) are not maintained by `ship`; leave them alone.

## Expo release (platform == mobile): version field and OTA decision

Applies when `feature.json.platform == "mobile"` (Expo / React Native).

### Delegation

If `expo:*` skills are available, invoke `expo:expo-overview` first, then `expo:eas-update` (OTA) or `expo:eas-app-stores` (native builds, store submission).

Fallback when they are not installed: see https://docs.expo.dev/eas-update/introduction/ and https://docs.expo.dev/build-reference/app-versions/. Minimum commands: `eas fingerprint:generate`, `eas fingerprint:compare`, `eas build:version:get`.

### Version field

- `ship` bumps `expo.version` in `app.json` (same semver rules as above). For `app.config.*` there is no manifest `ship` can edit: report it as a concern and do not hand-edit it.
- Do NOT hand-edit `ios.buildNumber` / `android.versionCode`. Leave them to EAS: `eas.json` `cli.appVersionSource: "remote"` plus `build.<profile>.autoIncrement: true`. With `remote`, app-config build numbers are ignored; `autoIncrement` never touches `expo.version`.
- If `appVersionSource` is not `remote`, report it as a concern; do not change `eas.json` unasked.

### OTA vs native build

1. Check `runtimeVersion` is `{ "policy": "fingerprint" }` in app config. If not, say so as a concern.
2. Compare the fingerprint of the currently released build against the new code: `eas fingerprint:compare <HASH1> <HASH2>` (or `--build-id` / `--update-id`; `--json` for parsing).
3. Same hash: **OTA-safe** (JS/asset-only change; `eas update` can ship it). Different hash: **native-build-required** (new store build needed).
4. Caveat: changes inside an inline config-plugin function body do not change the hash. Flag this if the diff touches config plugins.
5. If the hash cannot be computed (no released baseline, no EAS login), default to **native-build-required** and say why.

### Output

The orchestrator's summary MUST state exactly one of `OTA-safe` or `native-build-required`, e.g. `minor, 1.2.0 → 1.3.0, OTA-safe`.

### Never

Never run `eas build` or `eas update` (paid EAS services) automatically. Recommend them and leave the decision to the user.
