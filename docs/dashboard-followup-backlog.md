# Dashboard follow-up backlog

Items hidden from the DOM by `feat(dashboard): wire high-value UI; remove decorative stubs (R1..R9)` (PR #4 / commit `b665af1`), pending re-implementation as real working features. The original audit table with severities and source-file references lives in `docs/features/2026-05-11-14h-00m-dashboard-ui-gaps/spec.md`.

Status as of 2026-05-14 (after PR #15):

| ID | Feature | State | Effort | Notes |
|---|---|---|---|---|
| A | Toolbar filtering & sorting (Filters / Group / Sort) | ✅ **Shipped** PR #5 `dd02019` | — | TL-2, TL-3, TL-5 done. TL-4 Owner deferred (no `owner` field on tasks). |
| B | Sidebar nav routes (Bugfixes / Activity / Releases) | ✅ **Shipped** PR #6 `38fbd8f` | — | SB-2, SB-4, SB-5 done — three new routes under `app/(shell)/`. PR #7 `e7ab35e` renamed Features → Board with home navigation; PR #8 `000335e` synced /activity row to its wireframe (slug pill + phase/status chips + duration). |
| C | Pinned features `+` with persistence | ✅ **Shipped** PR #12 `3ca5ae7` | — | SB-7 done — `+` opens CommandPalette in pin-mode; localStorage source-of-truth; `POST /api/pins` + SSE `pinned-changed` broadcast for cross-client sync; native `storage` event for cross-tab same-browser. v1 client-side only; server-side per-user persistence is a follow-up. |
| D | Quick-add task on the board | ✅ **Shipped** PR #15 `22b2e47` | — | BD-1, BD-2 done. `+ Task` button on each Board column header **only when grouping by feature** (DOM-gated, not CSS-hidden). New `QuickAddTaskModal` (clone of NewFeatureModal): title (required, max 100) + 4-chip tag group (frontend/backend/mixed/infra; default mixed) + optional description. `POST /api/features/[id]/tasks` parses body, computes next Task N from a strict regex over plan.md, appends `- [TODO] **Task N** (<tag>): <title>` to the `## Tasks` list, and writes an optional `### Task N: <title>` stub to `## Task details`. Concurrency: allow-but-warn — amber banner when the target feature's `current_phase != 'done'`. Refresh rides existing chokidar SSE — no new event added. Two non-blocker a11y warnings (focus-trap missing on modal, error-row id uses React useId) tracked in test-report.md — inherited from NewFeatureModal, not regressions. |
| E | Agents catalog page | ✅ **Shipped** PR #13 `db08548` | — | SB-3 done — `/agents` route under `(shell)`, 8-column catalog (badge / name+desc / calls / approved / retried / time / tokens / last used). Active-first sort with zero-call agents bucketed at the bottom in muted tone. Snapshot extended with `agents` field aggregated from `.claude/skills/<name>/SKILL.md` + per-feature totals, so the page rides existing SSE refetch. AgentBadge registry expanded to all 18 canonical skills. Sidebar gains "Agents" as 5th nav-item. |
| F | Drawer reply-to-agent composer | Pending | **L** (3–5d) | DR-3, DR-4, DR-5. Highest-value, highest-effort. Requires an orchestrator-side message-bus extension so human replies on a task become a `human` history event the next subagent reads. |
| G | Alternate board views (Timeline / Agents / Table) | Deferred | L (3+d) | TL-1. Each view is its own component. Revisit only on demand — current Board covers the use case. |
| H | TopBar polish (orchestrator-state pill + user menu) | Partial — TB-1 ✅ **Shipped** PR #14 `3b28a4d` · TB-4 deferred | — | TB-1 done — `OrchestratorPill` in TopBar right cluster: idle/running pill driven by `useSnapshot()` (lex-max running feature when multiple), anchored popover with phase, 1-based Task X/Y, elapsed, and "+N more running" when applicable. Read-only (no pause/resume — CLI orchestrator has no control bus). Two phase-label maps (`CHIP` keeps `Implement`, `POPOVER` uses gerund `Implementing`) — see review.md cycles 1-3. TB-4 user-menu placeholder deferred — re-introduce when there's a real first menu action to wire. |
| I | LiveTicker `expand` overlay | Pending | S (½d) | LT-1. Same data as Feature B's Activity page in an overlay surface — defer until B lands so they share classification logic. |

## Suggested order

1. **I** — Ticker expand (S; B has shipped, the classification logic exists).
2. **F** — Drawer composer (L; B has shipped).
3. **G** — Alt views (L; deferred).
4. **H/TB-4** — TopBar user-menu, only when there's a real first action to wire.

## Tracked follow-ups

- a11y: focus-trap missing on `NewFeatureModal` / `QuickAddTaskModal`. Tab eventually escapes the modal. Pair with a sweep of all dashboard modals — single PR worth doing once.
- a11y: `QuickAddTaskModal` error-row id is generated via `useId()` rather than the literal `qa-title-error` named in the spec. Functionally equivalent (still wired through `aria-describedby`), but the spec contract says literal id. Fix when touching the file next.

## Out of scope (no plans to re-introduce)

- TopBar `YO` avatar (TB-4) — replaced by Feature H if/when shipped. The current placeholder is intentionally absent.
- Sidebar `Agents` raw nav link (SB-3) is covered by Feature E with a proper page; the standalone link wouldn't add value once E ships.

## Workflow

When picking up an item: invoke `/orchestrator <one-line description>` and reference this row. Each item is sized as a single `/orchestrator` run / single PR.
