---
name: auto-tester
disable-model-invocation: true
description: Writes and runs unit + integration tests for the current task. Detects the project's test runner from package.json / pyproject. Skipped entirely when feature.json.auto_tests == false.
---

# Auto Tester

## When to use

- Per-task dispatch by orchestrator when `feature.json.auto_tests == true`.
- Runs after the implementer has staged code, before code-reviewer.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` — the playbook core (shared contract). Read it before anything else.
2. `references/what-to-mock.md`
3. `references/coverage-targets.md`
4. `references/test-quality.md`
5. `<feature folder>/feature.json`
6. The current task slice from tasks file (`<feature folder>/plan.md` or spec.md `## Tasks`)
7. If `feature.json.platform == "mobile"` or `jest-expo` / `expo` is a dependency: `references/rn-jest-setup.md`

## The job

1. **Detect test runner** (vitest / jest / pytest / go test / cargo test).
   - Expo / React Native: if `feature.json.platform == "mobile"` or `jest-expo` / `expo` is a dependency → follow `references/rn-jest-setup.md` for the preset, RNTL and mocks before writing tests.
2. **Find the existing test conventions** in neighbouring files (location, naming, fixture style).
3. **Write tests** for the current task's acceptance criteria. Aim for 1 happy-path + 1-2 error paths per criterion.
4. **Run tests** with `node <CLI> check --scope touched --files <changed files> --steps test`, or the project test command with a quiet reporter (e.g. `--test-reporter=dot`). Never paste full test output into the report. If any fail due to the test (not the impl), fix the test. If they fail due to the impl, return `FAILED` with details.
5. **Audit mode** when `feature.json.tdd == true`: the implementer already wrote tests first. Run the touched tests, map the diff's tests to the live ACs, and write new tests only for ACs that would otherwise be `none` and for handled error paths without a test. Heading: `## Task <N> auto-tests (audit) — <ISO ts> — PASSED|FAILED`. Report over-budget tests as `- note: over budget AC<n> — <count> tests`; note bullets never start with `pass`, `fail`, `running` or `x`. Budget: see `references/coverage-targets.md`.
6. **Stage but do not commit** — the orchestrator commits.

## Output contract

End with the YAML block plus at most 5 lines of prose; never paste full test or tool output.

```yaml
---
status: PASSED | FAILED
output_file: docs/features/<folder>/test-report.md
failures_count: <N>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```

Append a section to `test-report.md`. Each test case is one bullet line in the
form `- [pass|fail|running] <case name> — <optional detail>` so the dashboard's
test-report panel can render per-case status:

```markdown
## Task <N> auto-tests — <ISO ts> — PASSED
- [pass] <case name>
- [pass] <case name>
```

If `FAILED`, list each failing case the same way and end with file:line + the
assertion mismatch:

```markdown
## Task <N> auto-tests — <ISO ts> — FAILED
- [pass] <case name>
- [fail] <case name> — <test file>:<line> expected X got Y
```

Also require a `## AC coverage — auto` section in `test-report.md`. It has one
bullet per live acceptance criterion that a test exercises or that you judged
untestable (skip superseded and removed ACs: those marked `[superseded → AC<n>]` or `(removed — D<n>)`), in the form:

```markdown
## AC coverage — auto
- [pass|fail|manual|none] AC<n>[, AC<m>|–AC<k>] — <test file> › "<test name>"
```

`pass`/`fail` = a test exercises the AC and its latest result; `manual` = the AC
is untestable automatically (needs a human or the visual tester); `none` = no
test covers it. Example: `- [pass] AC1, AC3 — src/foo.test.ts › "returns 200"`.

If this is the first section in the file, prepend YAML frontmatter so the
dashboard can read the latest verdict at a glance:

```markdown
---
status: PASSED|FAILED
failures_count: <N>
---
```

When appending later sections, leave the existing frontmatter in place and update
its `status` / `failures_count` to reflect the latest run.
