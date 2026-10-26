---
name: playbook
description: Core dev-cycle contract — feature folder, statuses, YAML report contract and limits. Read by path from every dev-cycle skill; the orchestrator also reads references/lifecycle.md. Not a standalone workflow.
disable-model-invocation: true
---

# Playbook — dev-cycle core

`${CLAUDE_PLUGIN_ROOT}` = the plugin root stated in the dispatch prompt.
Plugin-internal paths are relative to it; artefact paths (`docs/…`) to the target project.

State changes go only through the state CLI (`node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs`);
never hand-edit status, history or totals in `feature.json` / `spec.md` / `plan.md`.

§1, §1a, Bugfix flow, §1c, §4, §5, §7, §9, §10 — orchestrator only: `references/lifecycle.md`

## 2. Feature folder convention

Path: `docs/features/<YYYY-MM-DD-HHh-MMm>-<slug>/`

| File | Owner |
|---|---|
| `feature.json` | state CLI; never hand-edited (`feature set` for non-status keys) |
| `discovery.md` | discovery |
| `spec.md` | spec-writer (status flips by CLI); with `separate_plan == false` also `## Tasks`, `## Execution plan`, `## Task details` |
| `wireframes/*.html` | wireframer |
| `plan.md` | plan-writer (absent when `separate_plan == false`); status flips by CLI |
| `briefs/task-<n>.md` | CLI `brief <n>` (task detail, ACs, Touches, profile rules, lessons) |
| `gates/*.log`, `post-merge/*.log`, `content/*.log` | CLI `gate run`, `post-merge run`, `recipe run` |
| `review.md` | code-reviewer (rewritten each cycle, whole-feature) |
| `test-report.md` | visual-tester + auto-tester |
| `static-check-report.md`, `checks/<step>.log` | CLI `check` (report written on a FAILED tree-wide run) |

## 3. Status taxonomy

| Status | Meaning | Set by |
|---|---|---|
| `[TODO]` | Not started | plan-writer (or spec-writer when `separate_plan == false`) |
| `[IN PROGRESS]` | Implementer running (initial or fix cycle) | orchestrator |
| `[IMPL-DONE]` | Implementer DONE; awaiting end review | orchestrator |
| `[IN REVIEW]` | Findings in an active fix cycle | orchestrator |
| `[BLOCKED]` | Subagent BLOCKED, 3 fix cycles failed, or unresolvable conflict | orchestrator |
| `[DONE]` | End review approved + feature commit landed | CLI `git commit` |

## 6. Subagent report contract

Every subagent ends with this YAML block; the orchestrator parses only it.
Every subagent's final message is the YAML block plus at most 5 lines of prose.

### Universal

```yaml
---
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: docs/features/.../<file>.md   # or "n/a"
summary: <one sentence>
tokens_used: ~3.2k
duration: 2m 14s
concerns: <text>          # only if DONE_WITH_CONCERNS
needed_context: <text>    # only if NEEDS_CONTEXT
blocker: <text>           # only if BLOCKED
touches_expanded: []      # implementers: paths written outside `Touches:`;
                          # [] or omitted = stayed inside (collision check)
---
```

### Code-reviewer variant

```yaml
---
status: APPROVED | CHANGES_REQUIRED
output_file: docs/features/.../review.md
findings_count: 3
top_finding: <one sentence, only if CHANGES_REQUIRED>
lessons_added: 0          # required on CHANGES_REQUIRED; 0 when none added
tokens_used: ~1.1k
duration: 52s
---
```

### Tester variant (visual-tester, auto-tester)

```yaml
---
status: PASSED | FAILED
output_file: docs/features/.../test-report.md
failures_count: 0
tokens_used: ~2.3k
duration: 3m 12s
---
```

## 8. Limits

- Max 3 fix-loop cycles per task; then `[BLOCKED]` and escalate.
- Parallel dispatch within a glob-disjoint group; sequential between groups. End-of-feature gates also dispatch in one parallel message.
- Orchestrator never writes feature implementation files and never hand-edits status, history or totals; it calls the state CLI (`feature set` for `current_phase`, `areas`, `models`, etc.).
