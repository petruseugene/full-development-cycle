---
status: IN PROGRESS
---
# Spec: tasks in spec

## 1. Problem
Small feature; tasks live in the spec (separate_plan: false).

## 6. Acceptance Criteria
- [ ] AC1: the API returns items.
- [ ] AC2: the list renders items.
- [ ] AC3: unrelated criterion.

## Tasks
- [TODO] **Task 1** (backend): API endpoint
- [IMPL-DONE] **Task 2** (frontend): List view
- [IMPL-DONE] **Task 3** (backend, owner): Configure secrets

## Execution plan
- Group 1: Task 1, Task 3
- Group 2: Task 2

## Task details

### Task 1: API endpoint  `[TODO]`
**Tag:** backend
**Touches:** `api/**`
**Depends on:** none
**Size:** S
**Acceptance:** AC1

### Task 2: List view  `[IMPL-DONE]`
**Tag:** frontend
**Touches:** `web/**`
**Depends on:** Task 1
**Acceptance:** AC2

### Task 3: Configure secrets  `[IMPL-DONE]`
**Tag:** backend, owner
**Touches:** `ops/**`
**Depends on:** none
**Acceptance:** AC1
