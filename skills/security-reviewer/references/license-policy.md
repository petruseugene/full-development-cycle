# License Policy

Default policy. Projects may override by adding `feature.json.license_overrides` (a per-license verdict map) or by committing a project-level `LICENSE-POLICY.md`.

## Allow (no review)

- MIT
- BSD-2-Clause, BSD-3-Clause
- Apache-2.0
- ISC
- 0BSD
- Unlicense
- CC0-1.0
- Zlib

## Review (case-by-case — flag as `warning`)

- MPL-2.0 — file-level copyleft; usually fine but distribution-dependent.
- LGPL-2.1 / LGPL-3.0 — dynamic linking OK in most cases; static linking can trigger copyleft.
- EPL-2.0
- CDDL-1.0
- Artistic-2.0
- BSL-1.0 (Boost) — usually safe; verify wording.

## Deny (flag as `blocker`)

- GPL-2.0, GPL-3.0 — strong copyleft; viral for distributed software.
- AGPL-1.0, AGPL-3.0 — network-copyleft; usually unacceptable for SaaS.
- SSPL-1.0 — MongoDB-style; treat like AGPL.
- BUSL-1.1 — Business Source License; varies by source-availability terms.
- Proprietary / "Custom" / unknown — block until human review.

## Special cases

- **Multi-licensed** (e.g. `MIT OR Apache-2.0`): allow if any one option is on the allow list.
- **No `license` field**: treat as deny until clarified.
- **Local / file-path deps**: skip the license check (project-internal).

## Output

Each license-related bullet: `[blocker|warning] license — <pkg>@<version> — <SPDX id> on <deny|review> list`.
