---
feature: workflow-hardening
spec: ./spec.md
status: [DONE]
---

# Workflow Hardening — Plan

> **Dependency: Feature A (`skill-pack-v2`) must merge before Tasks 4 and 5 can start.**
> Tasks 1, 2, 3 are independent of Feature A and ship first. Tasks 4 (`static-check gate`) and 5 (`dod-gate`) reference the `static-checker` skill and the new reporter contracts introduced in `skill-pack-v2`; do not begin them until that PR has landed on `main`.
>
> All tasks are tagged `backend` — this feature is markdown/playbook edits + small orchestrator-side logic; the tag is the catch-all for non-frontend tooling work.

## Tasks

- [DONE] **Task 1** (backend): Visual-test rewind clarity (AC3)
- [DONE] **Task 2** (backend): Hotfix flow variant + git-agent cherry-pick recipe (AC4)
- [DONE] **Task 3** (backend): Budget warning line on dashboard (AC5, AC6, AC7)
- [DONE] **Task 4** (backend): Static-check gate in playbook §1 step 7 (AC1)
- [DONE] **Task 5** (backend): `dod-gate` aggregator before push (AC2)

## Task details

### Task 1: Visual-test rewind clarity  `[TODO]`

**Files:**
- `.claude/skills/_playbook.md` (edit §1 step 8 wording)
- `docs/workflows/agent-stack.md` (redirect visual-test FAILED arrow to a single task node)
- `.claude/skills/orchestrator/references/routing-edge-cases.md` (add 1-line rule)

**Acceptance:** AC3 — playbook §1 step 8 states the rewind target is "the task most likely responsible per the breadcrumb in `test-report.md`; escalate if unknown"; the diagram arrow terminates at a single task node, not the loop; the same rule is documented in `routing-edge-cases.md`.

**Steps:**
- [ ] Read current §1 step 8 in `_playbook.md` and rewrite to name the breadcrumb-driven rewind target and the escalate-if-unknown fallback.
- [ ] Update the visual-test failure arrow in `docs/workflows/agent-stack.md` so it points at a specific task node inside the per-task loop, not the loop boundary.
- [ ] Append a one-line rule to `routing-edge-cases.md` mirroring the playbook wording.
- [ ] Markdown-lint the three files; confirm no new warnings.

---

### Task 2: Hotfix flow variant + git-agent cherry-pick recipe  `[TODO]`

**Files:**
- `.claude/skills/_playbook.md` (new §1c section)
- `.claude/skills/git-agent/references/hotfix.md` (new file)
- `.claude/skills/git-agent/SKILL.md` (reference the new recipe + cherry-pick step)
- `docs/workflows/agent-stack.md` (new hotfix diagram)

**Acceptance:** AC4 — `§1c Hotfix flow` exists in the playbook with the two deltas (branch from latest release tag; cherry-pick to `main` post-merge); `git-agent/references/hotfix.md` contains the exact `git` / `gh` commands for tag lookup, cherry-pick, and conflict escalation; `git-agent/SKILL.md` links it; `agent-stack.md` shows a hotfix diagram.

**Steps:**
- [ ] Add `§1c Hotfix flow` to `_playbook.md` (placed after the bugfix flow). Describe it as bugfix-loop + two deltas; cross-reference the new recipe.
- [ ] Create `.claude/skills/git-agent/references/hotfix.md` with the tag-lookup command (`gh release view --json tagName`), branch-cut from tag, post-merge `git cherry-pick`, and the conflict-escalation case.
- [ ] Edit `git-agent/SKILL.md` to reference `hotfix.md` and add the cherry-pick step in its operations list.
- [ ] Add a hotfix diagram to `docs/workflows/agent-stack.md` mirroring the feature/bugfix diagram style.
- [ ] Markdown-lint all four files.

---

### Task 3: Budget warning line on dashboard  `[TODO]`

**Files:**
- `.claude/skills/orchestrator/SKILL.md` (dashboard render: budget-line logic; ~10 lines)
- `.claude/skills/orchestrator/references/dashboard-format.md` (document warning line format + defaults)
- `.claude/skills/_playbook.md` §5 (optional `feature.json.budget` schema doc)

**Acceptance:** AC5, AC6, AC7 — given `totals.tokens_k = 60` with no `budget` key the dashboard emits exactly one warning line naming the tripped threshold and current value; given `totals.tokens_k = 40` / `time_s = 300` and no `budget` key it emits zero warning lines; given `totals.tokens_k = 60` with `budget = { tokens_k: 100, time_s: 7200 }` it emits zero warning lines; `dashboard-format.md` documents the line format and defaults (50k tokens, 60 min).

**Steps:**
- [ ] In `orchestrator/SKILL.md`, add the budget-check logic: read `feature.json.budget` (default `{ tokens_k: 50, time_s: 3600 }`), compare against `totals.tokens_k` / `totals.time_s`, emit a single warning line if either trips.
- [ ] Document the warning line format and the default thresholds in `orchestrator/references/dashboard-format.md`.
- [ ] Extend `_playbook.md` §5 (`feature.json` schema) with the optional `budget` key and its shape `{ tokens_k: <int>, time_s: <int> }`.
- [ ] Hand-trace the three AC scenarios against the new logic; record the expected output for each in `dashboard-format.md`.
- [ ] Markdown-lint all three files.

---

### Task 4: Static-check gate in playbook §1 step 7  `[DONE]`

**Files:**
- `.claude/skills/_playbook.md` (insert §1 step 7c; add `static-checker` row to §7 routing table)
- `.claude/skills/orchestrator/SKILL.md` (dispatch table — add `static-checker` between implementer and code-reviewer)
- `docs/workflows/agent-stack.md` (update per-task loop diagram with the new node)

**Acceptance:** AC1 — `_playbook.md` §1 step 7 lists `static-checker` between 7b (implementer) and 7d (code-reviewer); §7 routing table contains a `static-checker` row with `PASSED` / `FAILED` actions; the `FAILED` text references the 3-cycle limit in §8; the per-task loop diagram in `agent-stack.md` shows the new dispatch.

**Steps:**
- [ ] Verify Feature A has merged and `static-checker` skill exists at `.claude/skills/static-checker/`.
- [ ] In `_playbook.md` §1, insert new step `7c` for `static-checker`; renumber the old 7c (`code-reviewer`) to `7d` and the old 7d/e/f accordingly. Wire routing: `PASSED` → code-reviewer; `FAILED` → re-dispatch implementer with the static-checker report, counts against the 3-cycle limit.
- [ ] Add a `static-checker` row to the §7 routing table with `PASSED` / `FAILED` actions mirroring the tester rows, referencing §8 for the limit.
- [ ] Update `orchestrator/SKILL.md` dispatch table to include `static-checker` in the per-task loop.
- [ ] Update the per-task loop diagram in `docs/workflows/agent-stack.md` to add a `static-checker` node between implementer and code-reviewer.
- [ ] Markdown-lint all three files.

---

### Task 5: `dod-gate` aggregator before push  `[DONE]`

**Files:**
- `.claude/skills/_playbook.md` (§1 step 9 names `dod-gate`, ordered before §1 step 10 push; §7 routing row for `dod-gate`)
- `.claude/skills/orchestrator/SKILL.md` (aggregator logic; ~30 lines)
- `.claude/skills/orchestrator/references/dod-gate.md` (new file — pass rule + escalation format)

**Acceptance:** AC2 — `_playbook.md` §1 step 9 names `dod-gate` and orders it before step 10 (`git-agent push`); `orchestrator/SKILL.md` describes the aggregator; `orchestrator/references/dod-gate.md` exists and contains the pass rule "every required gate's last entry in `feature.json.history` is `DONE` / `APPROVED` / `PASSED`"; on fail, orchestrator emits a one-line escalation naming the failing gate and aborts before push.

**Steps:**
- [ ] Verify Feature A has merged and the new reporter contracts are recorded in `feature.json.history`.
- [ ] Edit `_playbook.md` §1: insert `dod-gate` as the step between the post-visual-test status flip and step 10 (`git-agent push`). Add a `dod-gate` row to the §7 routing table (`PASSED` → push; `FAILED` → escalate, abort before merge).
- [ ] In `orchestrator/SKILL.md`, add the aggregator logic: read `feature.json.history`, check the last entry per required gate (`spec`, `plan`, every task implementer, `static-checker`, `code-reviewer`, `auto-tester` if enabled, `visual-tester` if enabled), pass only if every last entry is `DONE` / `APPROVED` / `PASSED`. On fail, emit a one-line escalation naming the gate and abort before push.
- [ ] Create `.claude/skills/orchestrator/references/dod-gate.md` documenting the pass rule, the list of required gates, and the escalation line format. Cross-reference from `orchestrator/SKILL.md`.
- [ ] Markdown-lint all three files.

---

```yaml
---
status: DONE
output_file: docs/features/2026-05-11-12h-15m-workflow-hardening/plan.md
summary: 5 tasks (all backend); first task: Visual-test rewind clarity. Tasks 4 & 5 blocked on Feature A (skill-pack-v2); Tasks 1-3 independent.
tokens_used: ~5.0k
duration: 2m 10s
---
```
