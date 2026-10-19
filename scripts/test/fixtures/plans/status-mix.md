---
feature: status-mix
spec: ./spec.md
status: [TODO]
---

# Status mix — Plan

## Tasks
- [IMPL-DONE] **Task 1** (backend): Parser
- [IMPL-DONE] **Task 2** (owner): Hand-owned doc task
- [TODO] **Task 3** (frontend): Widget with odd heading spacing
- [TODO] **Task 4** (backend): No detail section
- [BLOCKED] **Task 5** (backend): Blocked thing
- [IMPL-DONE] **Task 6** (mixed): Another done one
- [TODO] **Task 7** (backend): Later work

## Task details

### Task 1: Parser  `[IMPL-DONE]`
**Tag:** backend
**Touches:** `a/**`, `b.ts`
**Depends on:** none
**Size:** S
**Files:** `a/x.ts` (new)
**Acceptance:** AC1

### Task 2: Doc work  `[IMPL-DONE]` (owner)
**Touches:** `docs/**`
**Depends on:** none (independent)
**Size:** S

### Task 3: Widget  `[TODO]`
**Tag:** frontend
**Touches:** `ui/**`
**Depends on:** Task 1, Task 2
**Size:** M
**Wireframes:** wireframes/widget.html, wireframes/widget-empty.html
**Acceptance:** AC2, AC3

 ## Task 5: Blocked thing `[BLOCKED]`
**Depends on:** Task 1

### Task 6: Another  `[IMPL-DONE]`
**Depends on:** Tasks 1 and 3

### Task 7: Later  `[TODO]`
**Depends on:** Task 6
