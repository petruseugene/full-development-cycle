# Spec template

```markdown
---
feature: <slug>
created: <YYYY-MM-DD HH:mm>
status: [TODO]
flow: feature
---

# <Feature Name> — Spec

## 1. Problem & Goal
<2-4 sentences. The user-facing pain and the desired outcome.>

## 2. Non-goals
- <not doing X>
- <not doing Y>
- <not doing Z>

## 3. Users & Scenarios
- **<User type>**: <what they want to do>
- **<Scenario>**: <step-by-step happy path>

## 4. Requirements
- R1: <observable requirement>
- R2: ...

## 5. Constraints
- Performance: ...
- Security: ...
- Compatibility: ...

## 6. Acceptance Criteria
- [ ] AC1: <observable behaviour>
- [ ] AC2: ...

## 7. Out of Scope (v1)
- <thing deferred>

<!-- Optional, only when the threat look fires (see spec-writer SKILL.md step 5). Unnumbered, advisory, no dod gate. -->
## Threat notes
- **<area>:** <risk and the guard to apply>
```

## Combined mode (`separate_plan == false`)

When `feature.json.separate_plan == false`, append the unnumbered sections `## Tasks`, `## Execution plan` and `## Task details` after `## 7. Out of Scope (v1)`, in the format defined in `skills/plan-writer/references/task-format.md`. No separate `plan.md` is written.
