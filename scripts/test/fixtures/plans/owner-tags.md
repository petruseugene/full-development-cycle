---
status: IN PROGRESS
---
# Plan

## Tasks
- [IMPL-DONE] **Task 1** (backend): Plain backend task
- [IMPL-DONE] **Task 2** (owner): Owner-only step
- [IMPL-DONE] **Task 3** (backend, owner): Mixed owner step
- [IMPL-DONE] **Task 4**: Tag in details only
- [IMPL-DONE] **Task 5** (owner-ish): Not an owner task
- [TODO] **Task 6** (frontend): Frontend task

## Task details

### Task 1: Plain backend task  `[IMPL-DONE]`
**Tag:** backend
**Touches:** `api/**`
**Depends on:** none
**Acceptance:** AC1

### Task 2: Owner-only step  `[IMPL-DONE]`
**Tag:** owner
**Touches:** `ops/a/**`
**Depends on:** none
**Acceptance:** AC1

### Task 3: Mixed owner step  `[IMPL-DONE]`
**Tag:** backend, owner
**Touches:** `ops/b/**`
**Depends on:** none
**Acceptance:** AC1

### Task 4: Tag in details only  `[IMPL-DONE]`
**Tag:** owner
**Touches:** `ops/c/**`
**Depends on:** none
**Acceptance:** AC1

### Task 5: Not an owner task  `[IMPL-DONE]`
**Tag:** owner-ish
**Touches:** `misc/**`
**Depends on:** none
**Acceptance:** AC1

### Task 6: Frontend task  `[TODO]`
**Tag:** frontend
**Touches:** `web/**`
**Depends on:** none
**Acceptance:** AC2
