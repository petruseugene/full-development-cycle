---
feature: quick-add-task
spec: ./spec.md
status: [TODO]
---

# Quick-add Task on the Board (Feature D) — Plan

## Sequencing

Tasks are strictly ordered:

1. **Task 1 (backend)** ships the API contract first — Task 2 depends on the response shape (`{ task_number }`) and the 400/404 error strings rendered inline by the modal.
2. **Task 2 (frontend)** ships the `QuickAddTaskModal` component before Task 3, because Task 3 imports it.
3. **Task 3 (frontend)** wires the `+ Task` button into the Board column header and is the smallest edit.

The orchestrator must not begin Task 2 until Task 1 is `[DONE]`, nor Task 3 until Task 2 is `[DONE]`.

## Tasks

- [DONE] **Task 1** (backend): POST /api/features/[id]/tasks — parser-correct plan.md appender
- [DONE] **Task 2** (frontend): QuickAddTaskModal component (clone of NewFeatureModal)
- [DONE] **Task 3** (frontend): `+ Task` button in Board column header (feature grouping only)

## Task details

### Task 1: POST /api/features/[id]/tasks — parser-correct plan.md appender  `[TODO]`

**Tag:** backend

**Files:**

- New: `dashboard/app/api/features/[id]/tasks/route.ts`

Task 1 must NOT touch any non-API file (no client code, no `globals.css`, no parser changes).

**Acceptance:** AC7, AC8, AC9, AC10, AC11, AC12, AC13, AC14, AC15, AC16, AC17, AC20 (server side — no 409), AC23, AC24 (server side — no new `watcherHub.publish`).

**Implementation notes:**

- Mirror the route conventions of `dashboard/app/api/features/[id]/route.ts` and `dashboard/app/api/features/route.ts`:
  - `export const runtime = 'nodejs'`
  - `export const dynamic = 'force-dynamic'`
  - Handler signature: `export async function POST(req: Request, { params }: { params: { id: string } })`
- **Feature resolution** (R2): use the same lookup convention as `dashboard/app/api/features/[id]/route.ts` lines 7–14 (`loadFeatures()` → `find(f.id === params.id)`). Do not raw-`path.join` the URL segment — this is the documented traversal guard in the spec's Constraints section.
- On no-match → return `404 { error: 'feature not found' }`.
- **Body parse** (R3): wrap `await req.json()` in `try/catch`. On throw or non-object → `400 { error: 'invalid json' }` (match the failure shape of `POST /api/features`).
- **Body validation** (R4):
  - `title`: must be `typeof === 'string'`, `title.trim().length >= 1`, `title.trim().length <= 100`. Else `400 { error: <message> }`. Use messages aligned with the wireframe's error-row sample (e.g. `Title must be 100 characters or fewer.`).
  - `tag`: must be one of the literal strings `'frontend' | 'backend' | 'mixed' | 'infra'` (the parser's accepted set per `dashboard/lib/parsers.ts` line 23). Else `400`.
  - `description`: optional. When present, must be a string of length `<= 1000`. Else `400`.
- **plan.md path:** `path.join(featureFolderPath, 'plan.md')`. If `fs.access` / `fs.readFile` throws ENOENT → return `404 { error: 'plan.md not found' }` (R5).
- **Read once** (R9): a single `await fs.readFile(planPath, 'utf8')`.
- **Compute next N** (R6): scan plan.md line-by-line for matches of the regex (use exactly this regex — quoted verbatim):

  ```
  /^- \[(?:TODO|IN PROGRESS|IN_PROGRESS|DONE|BLOCKED|IN TESTING)\] \*\*Task (\d+)\*\* /
  ```

  `N = max(captured integers) + 1`. If no lines match → `N = 1`.
  Do not import `dashboard/lib/parsers.ts` — the parser's task line regex is broader; the appender needs the strict shape from the spec (R6). Inline this regex in the route file.
- **Build the appended task list-item line** (R10, R14) — exact byte format:

  ```
  - [TODO] **Task N** (<tag>): <trimmed-title>\n
  ```

  Single space between `Task` and `N`, single space between `**Task N**` and `(`, no space inside the parens around `<tag>`, `:` immediately after `)`, single space after `:`, then the trimmed title text. LF only — never CRLF. This shape is parser-correct per `dashboard/lib/parsers.ts` lines 31–55.
- **Insert position in `## Tasks`** (R11):
  - Locate the `## Tasks` header. Find the last contiguous list-item line (`/^- \[/`) under it. Insert the new line on the line immediately after that last list-item.
  - If `## Tasks` is empty (header present, no list items): insert the new line immediately after the blank line that follows the `## Tasks` header.
  - Do not insert *after* a trailing blank line — the new line stays inside the `## Tasks` section.
- **Task details section** (R12, R13):
  - When the request body's trimmed `description` is non-empty:
    - Build the section header line exactly as: `### Task N: <trimmed-title>` (level `###`, single space after `:`, then trimmed title). Spec section header format is binding (matches `## Task details` `### Task M: <title>` convention).
    - Build the section body: the user's `description` text verbatim (preserve internal `\n`), followed by a trailing `\n`.
    - Append the section to the bottom of the existing `## Task details` section, after the last existing `### Task M: ...` block, separated from the previous block by a single blank line.
    - When `## Task details` does not exist in the file: append it as a new top-level section at the end of the file, preceded by a single blank line, containing only the new `### Task N: <title>` subsection with the description as body (AC17).
  - When `description` is omitted or trims to empty: do **not** create a `### Task N` section (R13, AC15).
- **Write once** (R9): build the full next-version string in memory, then a single `await fs.writeFile(planPath, next, 'utf8')`. No `appendFile`, no temp-file + rename, no partial writes.
- **Response** (R7): `200 { task_number: N }`.
- **No 409** (R8, AC20): the handler must never return `409`. Concurrency is allow-with-warn; the only client-facing concurrency surface is the modal banner.
- **No new SSE event** (R28, AC24): do NOT call `watcherHub.publish(...)`. The chokidar watcher in `dashboard/lib/watcher.ts` will fire `change` automatically when `plan.md` is rewritten; the existing SSE pipeline handles refresh.

**Helpers to reuse (don't reinvent):**

- `loadFeatures()` (and whatever folder-path field it exposes) from the same place `dashboard/app/api/features/[id]/route.ts` imports it.
- `node:fs/promises` `readFile` + `writeFile`. No locking, no temp-file rename — match the `POST /api/features` precedent (`dashboard/app/api/features/route.ts` lines 31–58).

**Steps:**

- [ ] Create `dashboard/app/api/features/[id]/tasks/route.ts` with `runtime`, `dynamic`, and `POST` exports.
- [ ] Resolve feature folder via the `[id]` route's existing lookup convention; 404 on miss.
- [ ] JSON-parse body inside `try/catch`; 400 on parse failure or non-object.
- [ ] Validate `title` (string, trimmed len 1–100), `tag` (one of `frontend|backend|mixed|infra`), `description` (optional string, len ≤ 1000). 400 on any failure with a human-readable `error` string.
- [ ] Read `plan.md`; 404 with `plan.md not found` on ENOENT.
- [ ] Scan lines with the strict task-line regex; compute `N`.
- [ ] Build the appended task-list-item line (single-LF, exact spacing).
- [ ] Insert the line at the bottom of `## Tasks` (after the last existing list-item, before any trailing blank line).
- [ ] If description present after trim: build `### Task N: <title>` section; append to `## Task details` (or create `## Task details` if missing).
- [ ] Single `fs.writeFile` of the full next-version string.
- [ ] Return `200 { task_number: N }`.

---

### Task 2: QuickAddTaskModal component (clone of NewFeatureModal)  `[TODO]`

**Tag:** frontend

**Wireframes:** wireframes/modal-empty.html, wireframes/modal-filled.html, wireframes/modal-warning.html, wireframes/modal-validation-error.html

**Files:**

- New: `dashboard/components/QuickAddTaskModal.tsx`

Task 2 must not touch the Board, the API route, or `globals.css`.

**Acceptance:** AC3, AC4, AC5, AC6, AC18, AC19, AC22, AC32, AC33, AC34, AC35, AC36, AC37, AC38, AC39, AC40, AC41, AC42, AC43, AC44, AC45, AC46, AC47, AC48, AC49, AC50, AC51, AC52, AC53, AC54.

**Component contract:**

```ts
type QuickAddTaskModalProps = {
  open: boolean;
  onClose: () => void;
  featureId: string;
  featureSlug: string;        // header subhead "→ <feature.slug>" per AC33
  featureTitle: string;       // for the aria-label / banner phrasing
  currentPhase: string | null; // banner predicate per R23 / AC18
  onSuccess?: () => void;     // optional; modal closes on 200 regardless
};
```

**Implementation notes:**

- **Clone source:** `dashboard/components/NewFeatureModal.tsx` lines 67–117 is the literal template. Copy the file and adapt — do not introduce a shared `<Modal>` primitive (non-goal).
- **Overlay & panel** (AC32):
  - Outer wrapper: `fixed inset-0 z-50 cmdk-bg flex items-center justify-center` (centered — explicitly different from `NewFeatureModal`'s top-aligned `items-start justify-center pt-[16vh]`).
  - Panel: `w-[520px] rounded-xl border border-line bg-white shadow-2xl overflow-hidden`.
- **Dialog semantics** (AC34): `role="dialog"`, `aria-modal="true"`, `aria-labelledby="<header-span-id>"`. Outside-click close via `e.target === e.currentTarget` on the outer wrapper. Escape close via a document-level `keydown` effect (mirror `NewFeatureModal.tsx` lines 28–35). On close, return focus to the originating `+ Task` button (Task 3 hands a ref/callback; for Task 2 expose `onClose` and let the parent restore focus — the standard pattern in this codebase is for the parent to track the trigger).
- **Header** (AC33): `flex items-center gap-2 px-3.5 py-3 border-b border-line` row containing:
  - `<span class="text-[13px] font-semibold text-ink-900" id="<header-id>">Add task</span>`
  - mono subhead `→ <featureSlug>` (compose existing mono class — see wireframe)
  - `<span class="kbd">esc</span>` end-aligned (`margin-left:auto`).
- **Body** (AC35): `p-3.5 flex flex-col gap-3` container. Top-to-bottom order — Title field, Tag chip-group, Description field, warning banner (when present). Error row (when present) is anchored directly under the Title field.
- **Title field** (AC37, AC38):
  - Label: `Title (required)` with `(required)` wrapped in a `.req`-styled span (the wireframe uses a red color token; the wireframe carries the literal text `(required)` so color is not the sole signal).
  - Input: `<input id="qa-title" type="text" maxLength={100} aria-required="true" placeholder="What needs to be done?">`. Auto-focus on first paint (AC3 + AC37).
- **Tag chip-group** (AC6, AC39, AC40, AC45):
  - Container: `<div role="group" aria-labelledby="qa-tag-label">`.
  - Exactly four buttons in this order: `frontend`, `backend`, `mixed`, `infra`, each `<button type="button" class="chip <tag>">`.
  - Default state: `mixed` has `aria-pressed="true"`; the other three have `aria-pressed="false"`. Clicking another chip moves `aria-pressed="true"` to it and resets the others to `"false"`. Exactly one chip is pressed at any time.
  - Pressed visual: `font-weight: 700` + inset 2px `var(--ch-fg)` box-shadow ring; unpressed: `opacity: .55` on white. These are already declared in the existing `.chip.<tag>[aria-pressed=*]` rules — do NOT introduce new CSS classes.
- **Description field** (AC41):
  - `<textarea id="qa-desc" rows={4} maxLength={1000}>` with placeholder mentioning the `### Task N` section under `## Task details`.
  - Label: `Description (optional, max 1000)`.
  - Multi-line content (newlines) must be preserved on submit (AC46).
- **Warning banner** (AC18, AC19, AC24 client side, AC43, AC47, AC48, AC49, AC50):
  - Render predicate: `currentPhase != null && currentPhase !== 'done'`. Matches `OrchestratorPill.tsx` `isRunning` at lines 65–68.
  - When absent (currentPhase is `null`/`undefined` or equals `'done'`): the `[role="alert"]` warning element is not in the DOM (AC43, AC19).
  - When present: a `<div role="alert">` inside `.modal-body`, immediately below the Description field and above the footer.
  - Exact copy — verbatim, single space before `Continue?`, with `plan.md` wrapped in `<strong>`:

    > `Orchestrator is running on this feature (phase: <phase>). Your task will be added to plan.md immediately and may interleave with the orchestrator's edits. Continue?`

    where `<phase>` is the runtime value of `currentPhase` (no other transformation).
  - Tone tokens — compose existing utilities only (no new CSS class): background `#FFFBEB` (≈ `bg-amber-50`), border `1px solid #FDE68A` (≈ `border-amber-200`), text `#B45309` (≈ `text-amber-700`). The amber-700 token is already used in `TaskCard.tsx` line 78. A leading warning-triangle SVG icon precedes the text so color is not the sole signal.
  - Banner visible → submit remains enabled (no extra confirmation dialog).
- **Footer** (AC36): `px-3.5 py-2.5 border-t border-line flex items-center gap-2 justify-end` containing the `Cancel` button (`h-8 px-3 rounded-md border border-line bg-white text-[13px] text-ink-700 hover:bg-ink-50`) and the primary `Add task` button (`h-8 px-3 rounded-md bg-primary text-white text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed`).
- **Submit disabled rule** (R20, AC5, AC42, AC44):
  - `title.trim().length === 0` → `disabled` attribute present + `aria-disabled="true"` + `disabled:opacity-50 disabled:cursor-not-allowed` utilities applied.
  - Non-empty trimmed title → no `disabled` attribute + `aria-disabled="false"`.
- **Submit flow** (R21):
  - Build body `{ title: title.trim(), tag, description?: description.trim() || undefined }`.
  - `POST /api/features/${featureId}/tasks` with `Content-Type: application/json`.
  - On `200`: call `onSuccess?.()`, then `onClose()`. Do not optimistically insert (R28).
  - On `400` / `404`: keep the modal open, preserve all field values, render the inline error row (see below), reset `submitting` to `false` (mirror `NewFeatureModal.tsx` line 63) so the user can edit + retry (AC54).
- **Inline error row** (AC51, AC52, AC53, AC54):
  - Rendered directly under the Title input (since the most common 400 is title-length related).
  - Container: `<div role="alert" id="qa-title-error">` composing the existing `NewFeatureModal.tsx` lines 93–97 pattern: `rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px]` with `text-rose-600`.
  - Content: `<status-code> &nbsp; <server message>` (e.g. `400 Title must be 100 characters or fewer.`). The `<server message>` is the literal `error` string from the JSON response body. A leading circular-info SVG icon precedes the text so color is not the sole signal.
  - When the error row is visible: the Title input carries `aria-invalid="true"` and `aria-describedby="qa-title-error"`.
- **Pre-fill** (R22, AC22): `featureId` is supplied by the parent. The user does not pick a feature inside the modal. There is no feature picker.
- **No new CSS classes:** compose existing tokens only (`.chip.frontend|backend|mixed|infra`, `cmdk-bg`, `kbd`, `border-line`, `text-ink-*`, `bg-canvas`, `bg-primary`, `text-rose-600`, the `text-amber-700` / `border-amber-200` / `bg-amber-50` amber tokens, `req`). AC22 is enforced by diffing — no top-level class additions.

**Helpers to reuse (don't reinvent):**

- `dashboard/components/NewFeatureModal.tsx` — clone its overlay/panel/escape-effect/outside-click/error-row code wholesale; change `items-start ... pt-[16vh]` → `items-center justify-center` per AC32.
- The amber utility pattern from `TaskCard.tsx` line 78 (no new class).
- The `.chip.<tag>` styling from `TaskCard.tsx` line 47 / `CommandPalette.tsx` line 296.

**Steps:**

- [ ] `cp dashboard/components/NewFeatureModal.tsx dashboard/components/QuickAddTaskModal.tsx` and adapt props.
- [ ] Replace outer wrapper class with the centered variant (`items-center justify-center`, no `pt-[16vh]`).
- [ ] Rewrite header to `Add task → <featureSlug>` with `esc` kbd end-aligned.
- [ ] Add Title input (`maxLength={100}`, auto-focused, `aria-required="true"`).
- [ ] Replace the textarea-only body with the 4-chip Tag group (default `mixed`, `aria-pressed` invariant).
- [ ] Add Description textarea (`rows=4`, `maxLength={1000}`).
- [ ] Add conditional warning banner (predicate, exact copy with `<strong>plan.md</strong>`, amber tokens, warning-triangle icon).
- [ ] Footer: Cancel + `Add task` primary, with `disabled` + `aria-disabled` driven by `title.trim().length === 0`.
- [ ] Submit handler: POST → on 200 close + `onSuccess?.()`; on 400/404 render the inline error row under Title (with `aria-invalid` + `aria-describedby`), keep modal open, reset `submitting`.
- [ ] Escape-close + outside-click-close (`e.target === e.currentTarget`); parent restores focus to the trigger.

---

### Task 3: `+ Task` button in Board column header (feature grouping only)  `[TODO]`

**Tag:** frontend

**Wireframes:** wireframes/board-feature-grouped-button.html, wireframes/board-status-grouped-no-button.html

**Files:**

- Edit: `dashboard/components/Board.tsx` (the column header block around lines 56–72 — locate the existing column-header markup that already renders `col.label`, `col-pill`, `slug-pill`, and the phase chip).

Task 3 is a small edit. Do not touch any other file. Do not touch `globals.css`. Import `QuickAddTaskModal` from Task 2.

**Acceptance:** AC1, AC2, AC21, AC22 (no-new-CSS verification across Board change), AC24 (client side — no new `addEventListener('plan-changed', ...)` or similar), AC25, AC26, AC27, AC28, AC29, AC30, AC31.

**Implementation notes:**

- **Visibility predicate** (R15, AC1, AC2, AC25, AC29, AC30, AC31): render the `+ Task` button **only when `groupKey === 'feature'`**. In every other grouping mode (`status | tag | agent`) the button must be **absent from the DOM** — not hidden via CSS.
- **Per-column placement** (AC25): the button is the last item in the column header, end-aligned via `margin-left:auto` on the button itself (not on a wrapper). Header order (left-to-right): feature title `<h3 class="text-[13px] font-semibold text-ink-800">`, `<span class="col-pill">` count, `<span class="slug-pill mono">` slug, the current-phase chip `<span class="chip phase-<current_phase>">` (when non-null), then the `+ Task` button.
- **Button markup** (AC26, AC27, AC28):
  - `<button type="button">` with:
    - `aria-label="Add task to <feature.title>"` (the literal phrasing from R16 / AC26).
    - Visible content: a `+` glyph rendered as inline SVG (11×11, `stroke-width="2.4"`) followed by the literal text `Task`.
  - Styling — compose only existing tokens (no new top-level CSS class, per AC22 + AC27): height `24px`, padding `0 8px`, `border-radius: 6px`, `border: 1px solid var(--line)`, `background: #fff`, `color: var(--ink-700)`, `font-size: 12px`, `font-weight: 500` — these are the same atom values as the `NewFeatureModal.tsx` secondary button (h-8 → h-6, px-3 → px-2). The wireframe uses the local utility `.btn-add-task` for the prototype; in production, compose this on the button element directly using existing utility classes (do **not** create a new top-level CSS class). If a single-purpose composite class is unavoidable, reuse the existing button styling pattern from the Sidebar's `.pin-add-btn` (`Sidebar.tsx`).
  - Focus ring: 2px solid `var(--primary)` outline at `1px` offset on `:focus-visible` — match the existing pattern used by `Sidebar.tsx`'s `.pin-add-btn` (no new class).
- **Modal state & trigger** (R17, R22, AC3, AC4):
  - Add component-local state for `open: boolean` and `activeFeatureId: string | null` (or equivalent). Clicking a column's `+ Task` sets both, opening the single modal instance with the column's feature id.
  - Keep a ref / callback to the originating button so focus can be returned on close (the parent owns trigger-focus restore per Task 2's contract).
- **Render one modal instance** at the bottom of the Board component (sibling to the columns grid) with props `{ open, onClose, featureId, featureSlug, featureTitle, currentPhase }`. Pull `featureSlug` / `featureTitle` / `currentPhase` from the same feature record the column header already uses (`col.feature` or equivalent — locate in `Board.tsx`).
- **currentPhase wiring** (R23, AC18, AC19): pass `feature.meta?.current_phase ?? null`. The modal owns the banner-render predicate; Task 3 only forwards the raw value.
- **No new SSE handler** (R28, AC24): do not add `addEventListener('plan-changed', ...)`. Do not call `refresh()` directly from `onSuccess`. The existing chokidar `change` event already fires via `dashboard/lib/watcher.ts` → SSE → `dashboard/app/(shell)/layout.tsx` (250 ms debounce, AC21). The board will re-render within ~500 ms with no extra wiring.
- **Other grouping modes** (AC2, AC30, AC31): do not modify the status/tag/agent column-header rendering. Status columns (the 5 status keys) keep their existing leading status-dot + title + count and have zero `[aria-label^="Add task to "]` elements anywhere in the DOM.

**Helpers to reuse (don't reinvent):**

- The existing column-header JSX in `Board.tsx` lines 56–72. Extend it — don't rewrite.
- `QuickAddTaskModal` from Task 2 (single import, single instance rendered at the bottom of the component).
- The `groupKey` variable already in scope in `Board.tsx` (derived from `bucketBoard(features, groupKey)` per `dashboard/lib/board-filters.ts` lines 80–194).

**Steps:**

- [ ] In `Board.tsx`, add `useState` for `modalOpen: boolean` and `modalFeatureId: string | null` (plus trigger-button ref tracking for focus return if needed).
- [ ] Inside the column-header JSX, when `groupKey === 'feature'`, render the `+ Task` button (markup, label, focus ring) end-aligned via `margin-left:auto`.
- [ ] Wire `onClick` to set `{modalOpen: true, modalFeatureId: <this column's feature id>}` and capture the trigger for focus-return.
- [ ] Below the columns grid, render one `<QuickAddTaskModal open={modalOpen} onClose={...} featureId={modalFeatureId} featureSlug={...} featureTitle={...} currentPhase={feature.meta?.current_phase ?? null} />`. On `onClose`, reset state and restore focus to the captured trigger.
- [ ] Verify by DOM inspection that under `groupKey === 'status' | 'tag' | 'agent'` no `[aria-label^="Add task to "]` element exists (AC2, AC30).

---

## AC ownership map (every spec AC owned by exactly one task)

- **Task 1:** AC7, AC8, AC9, AC10, AC11, AC12, AC13, AC14, AC15, AC16, AC17, AC20, AC23, AC24 (server side).
- **Task 2:** AC3, AC4, AC5, AC6, AC18, AC19, AC22 (modal scope), AC32, AC33, AC34, AC35, AC36, AC37, AC38, AC39, AC40, AC41, AC42, AC43, AC44, AC45, AC46, AC47, AC48, AC49, AC50, AC51, AC52, AC53, AC54.
- **Task 3:** AC1, AC2, AC21, AC22 (board scope), AC24 (client side), AC25, AC26, AC27, AC28, AC29, AC30, AC31.

(AC22 — "no new top-level CSS classes" — is naturally cross-cutting; both Task 2 and Task 3 must observe it, and code-reviewer should diff `globals.css` after each task. AC24 — "no new SSE event" — splits naturally into server-side absence of `watcherHub.publish` (Task 1) and client-side absence of any new `addEventListener('plan-changed', ...)` (Task 3).)

---

status: DONE
output_file: docs/features/2026-05-14-16h-28m-quick-add-task/plan.md
summary: 3 tasks; first task: POST /api/features/[id]/tasks — parser-correct plan.md appender
tokens_used: ~7k
duration: 3m 40s
---
