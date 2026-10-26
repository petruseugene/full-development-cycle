---
feature: toolbar-filters-sort
spec: ./spec.md
status: [TODO]
---

# Toolbar — wire Filters, Group, and Sort — Plan

## Preamble

Five tasks, mapped 1:1 to the five spec requirement blocks (R1..R5). I considered
splitting the Filters popover (R1) from its state plumbing into two tasks, but the
popover's state model (three multi-selects, derived count badge, single-click clear)
is small enough that splitting would force the second task to re-open `Toolbar.tsx`
and `page.tsx` again — the seam isn't natural. Keeping R1 as one task gives the
implementer end-to-end ownership of the Filters slice and lets them resolve the
"state lives where" open question once for the whole feature.

Open-question resolutions baked into the plan (see individual tasks for details):

1. **Feature column label** (Q1 / AC2.2) → use `feature.title` to match the
   sidebar's existing convention; recorded in Task 2.
2. **State location** (Q2) → introduce `dashboard/components/DashboardShell.tsx`,
   a thin `'use client'` wrapper that owns `filters`, `groupKey`, `sortKey` state
   and renders both `Toolbar` and `Board`. `app/page.tsx` (Server Component) loads
   the data and hands it to the shell. Established in Task 1; reused by Tasks 2–3.
3. **Recency fallback chain** (Q3 / AC3.1) → keep the spec's chain
   `reviews[taskId].ts → meta.history[*].ts → feature.updatedAt`; if `updatedAt` is
   also absent, fall back to `0` (epoch) so the sort is deterministic. Noted in Task 3.
4. **8-agent cap** (Q4 / AC2.5) → keep the cap + `Other` bucket as written;
   implementer verifies fixture data does not currently hit the cap. Noted in Task 2.
5. **Popover viewport clamp** (Q5 / AC4.3) → implementer clamps the Sort popover to
   the viewport at <360px by switching the popover's anchor edge from `left-0` to
   `right-0` on the rightmost button. Owned by Task 4; verified by R5/visual-tester
   downstream.

Task dependency chain: 1 → 2 → 3 → 4 → 5. Task 1 establishes `DashboardShell` and
the filter-derivation utility that Tasks 2 and 3 extend. Task 4 is mostly visual
hygiene over the surface produced by Tasks 1–3. Task 5 is verification-only and
runs last.

A small shared utility module `dashboard/lib/board-filters.ts` is introduced in
Task 1 and extended in Tasks 2 and 3. Keeping the filter+group+sort derivation in
one pure module lets Task 5's no-regression check inspect a single seam and
makes the `Board` component diff small.

## Tasks

- [DONE] **Task 1** (frontend): Filters state + popover (R1)
- [DONE] **Task 2** (frontend): Group key + board re-bucketing (R2)
- [DONE] **Task 3** (frontend): Sort key + in-column ordering (R3)
- [DONE] **Task 4** (frontend): Toolbar UI hygiene + single-popover invariant (R4)
- [DONE] **Task 5** (mixed): R5 no-regression verification

## Task details

### Task 1: Filters state + popover (R1)  `[TODO]`

**Tag:** frontend
**Depends on:** none (kicks off the feature)
**ACs covered:** AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC1.6, AC1.7, AC1.8

**Files to create / modify:**

- `dashboard/app/page.tsx` — keep as a Server Component that fetches features and
  passes them to a new client wrapper. Replace the direct `<Toolbar /> <Board />`
  render with `<DashboardShell features={features} />`.
- `dashboard/components/DashboardShell.tsx` — **new**, `'use client'`. Owns the
  three pieces of state (`filters`, `groupKey`, `sortKey`) and renders `Toolbar`
  + `Board`. Task 1 introduces it with the `filters` slice only; Tasks 2 and 3
  add `groupKey` and `sortKey` to the same component.
- `dashboard/components/Toolbar.tsx` — add the `Filters` button + its popover.
  Existing `last sync …` rendering and outer `<div>` classes
  (`px-6 py-3 flex items-center gap-2 bg-canvas`) stay untouched per AC4.1 / AC4.5.
- `dashboard/components/FiltersPopover.tsx` — **new**. Renders the three sections
  (Status / Tag / Feature) as checkbox groups, the `Clear filters` footer link,
  the outside-click / Esc handlers, and the focus-management on open.
- `dashboard/lib/board-filters.ts` — **new**. Exports `applyFilters(tasks,
  filters, features)` returning the narrowed task list per the AND-across /
  OR-within rule (AC1.4). Pure, no React. Tasks 2 and 3 extend this module with
  `groupBy` and `sortBy`.

**Acceptance:**

- AC1.1 — label reads exactly `Filters` when `filters = { status: [], tag: [],
  feature: [] }`; the same tasks render that rendered on `b665af1` for the same
  fixture.
- AC1.2 — button toggle, outside-click, Esc — all three dismiss the popover.
- AC1.3 — popover renders Status / Tag / Feature in that order; Status options
  are the five `TaskStatus` values from `lib/types.ts`; Tag options are the four
  enum values; Feature options come from the same `features` array `Board`
  receives.
- AC1.4 — `applyFilters` implements `(status empty OR task.status ∈ status) AND
  (tag empty OR task.tag ∈ tag) AND (feature empty OR feature.id ∈ feature)`.
- AC1.5 — button label becomes `Filters (N)` where N is the **sum** of selected
  values across all three dimensions, recomputed each render.
- AC1.6 — `Clear filters` sets all three arrays to `[]` in a single call.
- AC1.7 — button carries `aria-haspopup="dialog"` and a state-tracking
  `aria-expanded`; checkboxes are native `<input type="checkbox">` with `checked`
  bound to state (axe accepts native checked-state as ARIA-equivalent).
- AC1.8 — on open, focus moves to the first checkbox (use a ref + `useEffect`
  keyed on `open`).

**Steps:**

- [ ] Add `Filters` type and default to `lib/board-filters.ts`; implement
  `applyFilters`.
- [ ] Create `DashboardShell.tsx`, lift `features` prop in, hold `filters` state.
- [ ] Convert `app/page.tsx` to render `<DashboardShell features={...} />`.
- [ ] Add `Filters` button to `Toolbar.tsx`; pipe `filters`, `setFilters`,
  `openPopover`, `setOpenPopover` down (the `openPopover` shape is needed for
  the single-popover invariant Task 4 finalises; introduce it now as a
  `'filters' | 'group' | 'sort' | null` union).
- [ ] Create `FiltersPopover.tsx`; wire outside-click + Esc + focus-move; render
  three sections + clear link.
- [ ] In `DashboardShell`, pass `applyFilters(allTasks, filters, features)` into
  `Board` so the board narrows synchronously.

**Concerns:** None — every AC1.x is concretely specified.

---

### Task 2: Group key + board re-bucketing (R2)  `[TODO]`

**Tag:** frontend
**Depends on:** Task 1 (consumes `DashboardShell`'s state-owner pattern and the
`board-filters.ts` module)
**ACs covered:** AC2.1, AC2.2, AC2.3, AC2.4, AC2.5, AC2.6, AC2.7, AC2.8

**Files to create / modify:**

- `dashboard/components/DashboardShell.tsx` — add `groupKey` state, default
  `'status'`. Pass `groupKey` to `Board`.
- `dashboard/components/Toolbar.tsx` — add the `Group: <Key>` button + a small
  `GroupPopover` (inline `<div>`, four radio inputs; closes on select per AC2.6).
- `dashboard/components/Board.tsx` — replace the hard-coded `COLUMNS` iteration
  with a derived `columns` array driven by `groupKey`. Keep the existing column
  visual + sticky header. Render the per-card status chip whenever `groupKey !==
  'status'` so the user does not lose status visibility (this is implied by the
  spec's "Cards retain their existing visual; status is preserved as the coloured
  `sd` dot/chip" clause in AC2.2 — verify the chip is unconditional, not gated on
  `groupKey === 'status'`).
- `dashboard/lib/board-filters.ts` — add `groupTasks(tasks, key, features)`
  returning `{ id: string; label: string; tasks: Task[] }[]`. Handles the
  Feature-cap+Other bucket (AC2.3), the empty-column hiding (AC2.3 / AC2.4), the
  Unassigned bucket for Agent (AC2.5), the 8-agent cap with alphabetical
  ordering (AC2.5).

**Acceptance:**

- AC2.1 — default `groupKey === 'status'` yields exactly the five existing
  columns in the existing order from `Board.tsx`'s `COLUMNS`.
- AC2.2 — `groupKey === 'feature'` produces one column per in-scope feature;
  column header uses **`feature.title`** (resolves open question #1; matches
  the sidebar's existing label per `dashboard/components/Sidebar.tsx`).
- AC2.3 — when >8 features are in scope, the first 8 in `features`-array order
  render individually and the rest collapse into `Other`. Count badges reflect
  per-bucket totals. Empty columns are filtered out.
- AC2.4 — `groupKey === 'tag'` produces up to four columns labelled `Frontend`,
  `Backend`, `Mixed`, `Infra` in that order; empty columns hidden.
- AC2.5 — `groupKey === 'agent'` buckets by entries in `task.activeAgents`; tasks
  with empty/undefined `activeAgents` go into `Unassigned`. Cap at 8 distinct
  agents (alphabetical), rest into `Other`.
- AC2.6 — label is exactly one of `Group: Status | Feature | Tag | Agent`;
  selecting a radio dismisses the popover.
- AC2.7 — popover dismiss semantics match Filters (outside-click + Esc); button
  has `aria-haspopup="menu"` + `aria-expanded`.
- AC2.8 — `groupKey` lives in `DashboardShell` React state; reload returns to
  `'status'`. No `localStorage`, no URL param.

**Steps:**

- [ ] Extend `board-filters.ts` with `groupTasks` + unit-equivalent assertions in
  the AC body of code-review (no jest tests; `auto_tests: false`).
- [ ] Add `groupKey` state and prop drilling in `DashboardShell`.
- [ ] Add `Group: <Key>` button + popover to `Toolbar.tsx`; reuse the same
  outside-click / Esc + `openPopover` slot introduced in Task 1.
- [ ] Refactor `Board.tsx` to render `groupTasks(applyFilters(...), groupKey,
  features)` instead of iterating `COLUMNS` directly. Preserve the column shell,
  sticky header, count badge, and card visuals exactly.
- [ ] Verify the per-card status chip on `TaskCard` renders for every `groupKey`
  (it should already; this task just guards against regressions).

**Concerns:**

- Open question #4 (agent cap): the spec admits "today, dashboards rarely have
  more than 8 distinct active agents." Keep the cap defensively; implementer
  should `console.log` distinct-agent count once during dev to confirm.

---

### Task 3: Sort key + in-column ordering (R3)  `[TODO]`

**Tag:** frontend
**Depends on:** Tasks 1 and 2
**ACs covered:** AC3.1, AC3.2, AC3.3, AC3.4, AC3.5, AC3.6, AC3.7

**Files to create / modify:**

- `dashboard/components/DashboardShell.tsx` — add `sortKey` state, default
  `'recent'`. Pass to `Board`.
- `dashboard/components/Toolbar.tsx` — add the `Sort: <Key>` button + a small
  `SortPopover` (three radio inputs; closes on select per AC3.4).
- `dashboard/components/Board.tsx` — apply `sortTasks(columnTasks, sortKey,
  feature)` after grouping; sort happens **inside each column independently**
  (AC3.5).
- `dashboard/lib/board-filters.ts` — add `sortTasks(tasks, key, feature)`
  implementing the three orderings with the deterministic tie-breakers
  (`task.index` ascending in all three cases).

**Acceptance:**

- AC3.1 — `'recent'` sorts by:
  1. latest `feature.reviews[].ts` whose `taskId === task.id` (max),
  2. else latest `feature.meta.history[*].ts`,
  3. else `feature.updatedAt`,
  4. else `0` (epoch — defensive against missing `updatedAt`; resolves
     open question #3).
  Ties broken by `task.index` ascending.
- AC3.2 — `'title'` sorts by `task.title.localeCompare(other.title, undefined,
  { sensitivity: 'base' })`. Ties by `task.index` ascending.
- AC3.3 — `'status'` orders by pipeline order
  `IN_PROGRESS > IN_TESTING > BLOCKED > TODO > DONE`. Ties by `task.index`
  ascending.
- AC3.4 — label is exactly one of `Sort: Recent | Title | Status`; selecting
  closes the popover.
- AC3.5 — verified by an integration check: Group=Tag + Sort=Recent — each tag
  column's first card is the most-recent task with that tag, independent of
  other columns.
- AC3.6 — popover dismiss matches Filters / Group; button has
  `aria-haspopup="menu"` + `aria-expanded`.
- AC3.7 — `sortKey` lives in `DashboardShell` React state; reload → `'recent'`.

**Steps:**

- [ ] Extend `board-filters.ts` with `sortTasks` + a `STATUS_PIPELINE_ORDER`
  constant.
- [ ] Add `sortKey` state in `DashboardShell`; thread to `Board`.
- [ ] Add `Sort: <Key>` button + popover to `Toolbar.tsx`.
- [ ] In `Board.tsx`, pipe each grouped column's `tasks` through `sortTasks`
  before render.

**Concerns:**

- Recency fallback (open question #3): resolved as `reviews → history →
  updatedAt → 0`. If implementer finds `Feature.updatedAt` is itself optional
  in `lib/types.ts`, keep the epoch fallback.

---

### Task 4: Toolbar UI hygiene + single-popover invariant (R4)  `[TODO]`

**Tag:** frontend
**Depends on:** Tasks 1, 2, 3 (consolidates their shared surface)
**ACs covered:** AC4.1, AC4.2, AC4.3, AC4.4, AC4.5, AC4.6

**Files to create / modify:**

- `dashboard/components/Toolbar.tsx` — finalise the left-to-right order, button
  classes, popover positioning, single-popover invariant, and viewport clamp.
- (Optional) `dashboard/components/FiltersPopover.tsx` and the two inline
  popovers in `Toolbar.tsx` — minor positioning class adjustments if the
  viewport clamp requires per-popover right-alignment.

**Acceptance:**

- AC4.1 — left-to-right: `Filters` button, `Group: <Key>`, `Sort: <Key>`, flex
  spacer, `last sync <ago>`. Outer classes unchanged
  (`px-6 py-3 flex items-center gap-2 bg-canvas`).
- AC4.2 — all three buttons use the existing `selpill` class (verify by reading
  the design source noted in `feature.json.design_source` — the pre-Task-1
  Toolbar in git history at `b665af1~5:dashboard/components/Toolbar.tsx`). No
  new CSS rules added to `globals.css` or any Tailwind config.
- AC4.3 — each popover renders with `absolute top-full mt-1 left-0 z-20`
  (above the column sticky headers which use `z-10`). Sort popover gets a
  viewport-clamp class — switch to `right-0` (instead of `left-0`) so it does
  not overflow at <360px (resolves open question #5).
- AC4.4 — single-popover invariant: the `openPopover` union state introduced in
  Task 1 ensures opening one popover sets the other two closed. Verify by
  inspecting the `setOpenPopover` calls in the three buttons.
- AC4.5 — `last sync <ago>` continues to render via `relativeAgo`; the flex
  spacer between Sort and the timestamp absorbs any width changes. No layout
  shift when filters are toggled (popover is `absolute`, doesn't displace
  siblings).
- AC4.6 — `dashboard/package.json` diff vs `b665af1` shows zero added runtime
  dependencies. No Headless UI, Radix, Floating UI, Popper.

**Steps:**

- [ ] Final pass on button ordering + spacing in `Toolbar.tsx`.
- [ ] Verify the `selpill` class is the existing one by reading
  `b665af1~5:dashboard/components/Toolbar.tsx` (the design-source pointer).
- [ ] Set z-index on popovers; check against `Board.tsx` sticky-header z-index.
- [ ] Audit the three button click handlers to confirm they call
  `setOpenPopover(name === openPopover ? null : name)` so toggling between them
  cannot leave two open simultaneously.
- [ ] Add `right-0` (or `right-2`) override on the Sort popover for <360px.
- [ ] Run `git diff -- dashboard/package.json` (Task 5 verifies again).

**Concerns:**

- The exact pre-deletion `selpill` styling is in git history, not the current
  tree. If the class no longer exists in `dashboard/styles/globals.css`,
  re-add it (still no new dependency) and note in the commit message.

---

### Task 5: R5 no-regression verification  `[TODO]`

**Tag:** mixed
**Depends on:** Tasks 1, 2, 3, 4
**ACs covered:** AC5.1, AC5.2, AC5.3, AC5.4, AC5.5, AC5.6, AC5.7, AC5.8

**Files to create / modify:** none under normal operation. Implementer touches
production code **only if a regression is found**, in which case the offending
file (most likely `dashboard/app/page.tsx`, `Toolbar.tsx`, or `Board.tsx`) is
patched and the regression is documented in the commit message.

**Acceptance:**

- AC5.1 — `Cmd+K` opens the command palette while a Toolbar popover is open;
  popover does not capture the keystroke. Selecting a palette result navigates
  or opens the drawer as before.
- AC5.2 — Clicking a task card opens the Task drawer; outside-click and Esc
  close it. Same DOM, same behaviour as `b665af1`.
- AC5.3 — The New-feature modal opens from its existing trigger; submission
  posts to the same backend route as before. Diff `dashboard/components/NewFeatureModal.tsx`
  vs `b665af1` should be zero.
- AC5.4 — The KPI strip renders five tiles in the same order with the same
  data. KPIs reflect the **full** dataset, not the filtered one. Verify by
  reading the KPI strip's data prop in `app/page.tsx` — it must receive the
  unfiltered task list (likely all-tasks-across-features), not the post-
  `applyFilters` result.
- AC5.5 — The LiveTicker renders the same history entries in the same order;
  it does **not** consume `filters`. Verify by inspecting its prop wiring.
- AC5.6 — The sidebar renders the same features in the same order regardless of
  feature-filter selections in R1. Sidebar's `features` prop is the raw array,
  not the filtered subset.
- AC5.7 — `cd dashboard && pnpm tsc --noEmit` (or the npm/pnpm equivalent
  exposed in `package.json`) passes with zero errors.
- AC5.8 — No console errors or warnings in browser devtools on hard refresh
  with default state, and after toggling each Toolbar control once.

**Steps:**

- [ ] Run `cd dashboard && pnpm tsc --noEmit` (or `pnpm run typecheck` /
  `npm run typecheck`, whichever `package.json` exposes); fix any compile
  errors that surfaced from Tasks 1–4.
- [ ] Run `pnpm dev` (or `npm run dev`); hard-refresh; open devtools console;
  toggle each Toolbar control once; record zero errors / warnings.
- [ ] Spot-check the five R5 regression points: palette `Cmd+K`, card →
  drawer, New-feature modal trigger, KPI tiles, LiveTicker, sidebar.
- [ ] Verify KPI / LiveTicker / sidebar prop wiring uses the **unfiltered**
  task and feature arrays (not the `applyFilters` output).
- [ ] Confirm `git diff b665af1 -- dashboard/package.json` shows no added
  dependencies (re-check of AC4.6 since this is the no-regression gate).
- [ ] If any regression is found, fix in-place and note in the commit; do not
  open a new task.

**Concerns:**

- This task has no production-code deliverable in the happy path, which is
  unusual. Treat the deliverable as the verification record itself: the
  implementer's commit message must list each AC5.x with a one-line pass note.

---

```yaml
---
status: DONE
output_file: docs/features/2026-05-11-15h-32m-toolbar-filters-sort/plan.md
summary: 5 tasks (R1 Filters popover + state, R2 Group key, R3 Sort key, R4 Toolbar hygiene, R5 no-regression verification) with all 36 ACs mapped, exact file paths listed, and all 5 spec open questions resolved with defaults in-task.
tokens_used: ~7.0k
duration: 3m 20s
---
```
