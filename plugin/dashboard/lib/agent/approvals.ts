/**
 * Per-session approval state — pending requests + remember-allowlist.
 *
 * Spec references:
 *   - R6  — canUseTool wrapper + decision semantics
 *   - R12 — POST /api/agent/[featureId]/approval (Task 7 consumer)
 *   - R14 — GET  /api/agent/approvals (Task 7 consumer)
 *
 * Task 3 owns this module. It is intentionally tiny: just types + a
 * factory for the per-session `ApprovalState` record. The session
 * manager attaches one of these to every `SessionRecord` and the
 * `canUseTool` wrapper in `session-manager.ts` is the only consumer
 * besides Task 7's HTTP route.
 *
 * The remember-allowlist is in-memory only and is intentionally NOT
 * persisted across server restarts (spec R6: "The allowlist is
 * in-memory only; it does NOT persist across server restarts.").
 */

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * Public view of a single pending approval request.
 *
 * Surfaced over SSE inside an `approval_request` event (Task 5) and
 * over JSON via `GET /api/agent/approvals` (Task 7) so the TopBar pill
 * can list pending approvals across every active session.
 */
export interface PendingApproval {
  /** Server-generated request id. Stable for the life of one request. */
  id: string;
  featureId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: string;
}

/**
 * Internal entry stored in `ApprovalState.pending`. Carries the
 * Promise's `resolve` / `reject` so `respondApproval(...)` can settle
 * the awaited `canUseTool` callback without re-walking the SDK.
 *
 * `toolInput` is captured at request time so the resolver can echo the
 * exact input back as `updatedInput` (spec R6 — the dashboard never
 * mutates inputs, but the SDK signature requires the field).
 */
export interface PendingApprovalEntry {
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: string;
  resolve: (result: PermissionResult) => void;
  reject: (err: Error) => void;
}

/**
 * Per-session approval record attached to every `SessionRecord`.
 *
 *  - `allowlist` — tool names the user clicked "Approve & remember"
 *    for in this session. Checked first by the wrapper; if present the
 *    wrapper short-circuits to `{ behavior: 'allow' }`.
 *  - `pending`   — outstanding requests keyed by request id. A request
 *    lives here from emit-time until `respondApproval` (or an abort)
 *    settles it.
 */
export interface ApprovalState {
  allowlist: Set<string>;
  pending: Map<string, PendingApprovalEntry>;
}

/** Factory — every new `SessionRecord` gets a fresh `ApprovalState`. */
export function createApprovalState(): ApprovalState {
  return {
    allowlist: new Set<string>(),
    pending: new Map<string, PendingApprovalEntry>(),
  };
}

/** Decisions accepted by `respondApproval` (spec R6). */
export type ApprovalDecision = 'allow' | 'allow_and_remember' | 'deny';
