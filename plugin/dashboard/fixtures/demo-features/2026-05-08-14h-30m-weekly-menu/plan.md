---
feature: weekly-menu
spec: ./spec.md
status: [IN PROGRESS]
---

# Weekly Menu — Plan

## Tasks
- [DONE] **Task 1** (backend): Recipes endpoint returns 7-day window
- [DONE] **Task 2** (frontend): Week grid scaffolding with day columns
- [DONE] **Task 3** (frontend): Recipe card with serving size + swap button
- [IN PROGRESS] **Task 4** (frontend): Drag a recipe between days
- [IN TESTING] **Task 5** (backend): Persist menu changes to /api/menus
- [BLOCKED] **Task 6** (mixed): Shopping list aggregation across the week
- [TODO] **Task 7** (frontend): Empty + loading + error states
- [TODO] **Task 8** (frontend): Print-friendly weekly view

## Task details

### Task 4: Drag a recipe between days  `[IN PROGRESS]`
**Files:** apps/web/menu/WeekGrid.tsx, apps/web/menu/useDrag.ts
**Acceptance:** Dragging a card between day columns updates state optimistically and persists via PATCH. Cancelling the drag restores position.
**Steps:**
- [x] Pointer-down ghosting
- [x] Snap to closest day column
- [ ] Optimistic update + PATCH
- [ ] Cancel restores

### Task 5: Persist menu changes to /api/menus  `[IN TESTING]`
**Files:** apps/api/menus/route.ts, apps/api/menus/menus.service.ts
**Acceptance:** PATCH /api/menus/:weekId accepts a list of (day, recipeId) pairs and returns the updated week. Auto-tester covers concurrent edits.

### Task 6: Shopping list aggregation across the week  `[BLOCKED]`
**Files:** apps/api/menus/shopping.ts
**Acceptance:** GET /api/menus/:weekId/shopping returns a deduplicated list of ingredients with summed quantities and units.
