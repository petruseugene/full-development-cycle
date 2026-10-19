---
feature: weekly-menu
status: [DONE]
---

# Weekly Menu — Spec

## Problem
Users plan meals one day at a time. They want a 7-day overview they can rearrange and turn into a shopping list.

## Goals
- See all 7 days at once, with recipes in each slot.
- Drag a recipe from one day to another.
- Generate a deduplicated shopping list for the week.

## Non-goals
- Recipe editing (out of scope; only assignment).
- Cross-week planning (single week only).

## Acceptance criteria
- [x] /api/recipes returns a 7-day window with assigned recipes.
- [ ] Dragging a card persists the new assignment.
- [ ] Shopping list combines duplicate ingredients.
