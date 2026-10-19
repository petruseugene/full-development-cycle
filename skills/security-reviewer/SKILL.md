---
name: security-reviewer
description: Diff-based OWASP top-10 review, secret detection, authz / data-exposure checks for the just-implemented task. Appends findings to review.md and returns APPROVED or CHANGES_REQUIRED. Skipped when feature.json.security_review == false.
disable-model-invocation: true
---

# Security Reviewer

## When to use

- Per-task dispatch, in parallel with `dev-cycle:code-reviewer`, against the just-implemented diff.
- Skipped when `feature.json.security_review == false`.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` — the playbook core (shared contract). Read it before anything else.
2. `references/owasp-checklist.md`
3. `references/secret-patterns.md`
4. The task's acceptance criteria: on the full track `<feature folder>/briefs/task-<n>.md` (including its `## Threat notes`, when present); otherwise the tasks file (`plan.md` or spec.md `## Tasks`)
5. Dependency audit only: `references/audit-recipes.md`, `references/license-policy.md`
6. If `feature.json.platform == "mobile"`: `references/mobile-checklist.md`

## The job
1. Get the diff: `git diff --staged` (preferred) or `git diff <prev-commit>..HEAD`.
2. Treat any `## Threat notes` in the brief as advisory focus areas. For each changed file, walk `references/owasp-checklist.md`. Flag concrete OWASP top-10 risks introduced by *this diff*. Do not audit unchanged code.
   - On `platform == "mobile"`, also apply `references/mobile-checklist.md`.
3. Scan added lines against `references/secret-patterns.md` for API keys, tokens, private keys, hard-coded credentials.
4. **Authz check**: every new endpoint, route, handler, or job must have an auth/permission gate or an explicit "intentionally public" comment.
5. Severity: `blocker` (exploitable now) vs `warning` (deferrable). Only blockers cause CHANGES_REQUIRED.
6. Append findings to `<feature folder>/review.md` under a security subsection. Reuse the heading style of `dev-cycle:code-reviewer` so the dashboard parses both verdicts.

## Dependency audit (once per feature)
Runs once per feature, after the final tester pass and before release, only when `feature.json.dependency_audit == true` (also when `security_review == false`: dispatched in dependency-audit-only mode, skip the diff review); record history phase `deps-audit`.
1. Detect ecosystem from the lockfile (npm, Python, `Cargo.lock`, `go.sum`).
2. Run the audit per `references/audit-recipes.md`; threshold `high` unless `feature.json.dependency_audit_threshold` says otherwise.
3. License-check newly added direct deps (`git diff main..HEAD -- <lockfile>`) against `references/license-policy.md`.
4. Append the SBOM summary (name, version, license, advisory ids) to `<feature folder>/test-report.md` under `## Feature dependency-audit — <ISO ts> — PASSED|FAILED`, one bullet per result. PASSED if nothing at or above threshold and no deny-list license; else FAILED.

## Output contract

Final message: the YAML block plus at most 5 lines of prose (playbook core §6).

```yaml
---
status: APPROVED | CHANGES_REQUIRED   # dependency audit: PASSED | FAILED
output_file: docs/features/<folder>/review.md
findings_count: <N>
top_finding: <one sentence, only if CHANGES_REQUIRED>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```

Append:

```markdown
## Task <N> · security · cycle <K> — APPROVED|CHANGES_REQUIRED — <ISO ts>
- [blocker] path:line — <OWASP category> — <issue>
- [warning] path:line — <OWASP category> — <issue>
```
