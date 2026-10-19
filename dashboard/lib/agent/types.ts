/**
 * Shared types for the dashboard Agent SDK integration.
 *
 * Spec references:
 *   - R3  — on-disk session metadata
 *   - R4  — NDJSON event log
 *   - R6  — approval queue (slot reserved, populated by Task 3)
 *   - R7  — stats accumulator (slot reserved, populated by Task 4)
 *   - R8  — SSE event types
 *   - R41 — globalThis singleton
 *
 * This module is the single source of truth for SessionStatus,
 * AgentEvent, SessionMeta (on disk) and SessionRecord (in memory).
 * Tasks 3, 4, 5, 6, 7, 8 will all import from here.
 */

import type { EventEmitter } from 'node:events';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Session lifecycle states (R3 + R5).
 *
 *  - `running`           — SDK iterator is alive and consuming events
 *  - `idle`              — SDK reported completion; chat remains usable (R44)
 *  - `awaiting_approval` — `canUseTool` is blocked on a user decision (R30)
 *  - `errored`           — iterator threw a non-recoverable error
 *  - `killed`            — `kill()` aborted the controller (R6 / R13)
 *  - `orphaned`          — metadata on disk, no live in-process session (R5)
 */
export type SessionStatus =
  | 'running'
  | 'idle'
  | 'awaiting_approval'
  | 'errored'
  | 'killed'
  | 'orphaned';

/**
 * Discriminated union of events the dashboard forwards over SSE (R8).
 *
 * Producer (session manager) appends every event as one line of NDJSON to
 * `<featureId>.events.jsonl` (R4) AND emits over the in-memory emitter. The
 * consumer (Task 5 SSE route) replays the ring buffer then forwards live
 * events.
 *
 * `id` is monotonically increasing per-session; the SSE route uses it as the
 * `id:` field so the browser's EventSource can resume after a reconnect.
 * `ts` is the ISO timestamp at the moment the manager observed the event.
 */
export type AgentEvent =
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | ApprovalResolvedEvent
  | UsageEvent
  | StatusEvent
  | ErrorEvent;

export interface AgentEventBase {
  id: number;
  ts: string;
}

/**
 * Streaming text delta from the assistant.
 *
 * The frontend coalesces chunks sharing `messageId` into a single rendered
 * block (R27 assistant_text bullet). A `status` event with
 * `phase: 'message_end'` (or a new `messageId`) flushes the block.
 */
export interface AssistantTextEvent extends AgentEventBase {
  type: 'assistant_text';
  messageId: string;
  delta: string;
}

/** Tool-use block observed in an assistant message. */
export interface ToolCallEvent extends AgentEventBase {
  type: 'tool_call';
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Result block emitted by the SDK paired with a prior `ToolCallEvent`. */
export interface ToolResultEvent extends AgentEventBase {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  /**
   * Optional structured payload — for `Task` tool results this carries the
   * subagent's `usage`, `total_cost_usd`, `duration_ms` (R7). Forwarded as-is
   * for downstream consumers (Task 4 stats accumulator).
   */
  raw?: unknown;
}

/** Approval request — produced by Task 3's canUseTool wrapper. Slot reserved here. */
export interface ApprovalRequestEvent extends AgentEventBase {
  type: 'approval_request';
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: string;
}

/** Approval resolved — produced by Task 3's respondApproval. */
export interface ApprovalResolvedEvent extends AgentEventBase {
  type: 'approval_resolved';
  requestId: string;
  decision: 'allow' | 'allow_and_remember' | 'deny';
}

/** Usage tick — Task 4 consumes these to update the stats accumulator. */
export interface UsageEvent extends AgentEventBase {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/**
 * Status transition or boundary marker.
 *
 * `phase` lets the frontend coalesce assistant text (`message_end`) and
 * lets the manager broadcast lifecycle changes (`started`, `idle`, `killed`,
 * `errored`, `resumed`, `no_session`).
 */
export interface StatusEvent extends AgentEventBase {
  type: 'status';
  status: SessionStatus | 'no_session';
  phase?: 'started' | 'message_end' | 'idle' | 'killed' | 'errored' | 'resumed';
  message?: string;
}

/** Non-recoverable error surfaced from the SDK iterator. */
export interface ErrorEvent extends AgentEventBase {
  type: 'error';
  message: string;
  retryable: boolean;
  /** Machine-readable cause when the SDK reported one (e.g. billing). */
  code?:
    | 'billing_error'
    | 'authentication_failed'
    | 'rate_limit'
    | 'invalid_request'
    | 'server_error'
    | 'max_output_tokens'
    | 'oauth_org_not_allowed'
    | 'unknown';
}

/**
 * On-disk session metadata persisted to
 * `dashboard/.runtime/sessions/<featureId>.json` (R3).
 *
 * The in-memory `AbortController` and SDK iterator handle are NOT persisted
 * — those live only on `SessionRecord`.
 */
export interface SessionMeta {
  sessionId: string;
  featureId: string;
  startedAt: string;
  lastEventAt: string;
  status: SessionStatus;
  cwd: string;
}

/**
 * Slot reserved for Task 3 — per-session approval queue + remember-allowlist.
 * Task 3 will replace this `unknown` with its real shape from `approvals.ts`.
 * Keeping the slot here documents the contract without coupling Task 2.
 */
export type ApprovalSlot = unknown;

/**
 * Slot reserved for Task 4 — per-session stats accumulator. Task 4 will
 * replace this `unknown` with `SessionStats` from `stats.ts`.
 */
export type StatsSlot = unknown;

/**
 * In-memory session record (R3 + R4 + R41).
 *
 * Owned by the session manager; never serialised to disk. Persisting any
 * field on this record requires going through `persistMeta()` which writes
 * only the `SessionMeta` subset.
 */
export interface SessionRecord {
  meta: SessionMeta;
  /**
   * Abort signal driving `kill()`. The SDK's `canUseTool` callback receives
   * this signal in its options object; the iterator-consumer task respects
   * it for graceful shutdown.
   */
  abort: AbortController;
  /**
   * Active SDK `Query` handle. `null` between `kill()` and the next
   * `start()` / `resume()`. Reassigned on resume.
   */
  query: Query | null;
  /**
   * Stream-input bridge: the `prompt` async iterable passed to `query()`
   * pulls from this queue. `send()` pushes here; the generator drains.
   * `null` when there is no live SDK iterator.
   */
  inputQueue: SessionInputQueue | null;
  /**
   * Last 1000 events for SSE replay on reconnect (R8 / Constraints §5).
   * Older events stay on disk in the NDJSON log.
   */
  ringBuffer: AgentEvent[];
  /**
   * In-memory fan-out emitter. The Task 5 SSE route subscribes to its
   * `'event'` topic and forwards each `AgentEvent` to the browser.
   */
  emitter: EventEmitter;
  /** Monotonic event-id counter (used to stamp each emitted AgentEvent). */
  nextEventId: number;
  /** Reserved slot for Task 3's approval state (queue + allowlist). */
  approvals: ApprovalSlot;
  /**
   * Per-session stats accumulator (Task 4). Populated lazily on first
   * event the consumer observes. Typed as `StatsSlot` (unknown) to keep
   * `types.ts` decoupled from `stats.ts`; the session-manager narrows
   * back to `SessionStats` at the access site.
   */
  stats: StatsSlot;
  /**
   * Task tool-use → subagent attribution map (Task 4). Populated when a
   * `tool_call` with `name === 'Task'` is observed and consulted when
   * the matching `tool_result` arrives so the subagent ledger picks up
   * the optional `usage` / `total_cost_usd` / `duration_ms` fields.
   *
   * Typed as `unknown` for the same decoupling reason as `stats`; the
   * session-manager narrows it to `Map<string, string>`.
   */
  taskToolCallToSubagent: unknown;
  /**
   * In-flight tool calls keyed by `tool_use_id` (Task 4). Stores the
   * `tool_call` start timestamp so the matching `tool_result` can
   * compute and add `durationMs` to the per-tool ledger.
   */
  pendingToolCalls: unknown;
  /**
   * Epoch-ms of the last write to `<featureId>.stats.json` (Task 4).
   * Used to throttle the flush at 5 s while events stream and to force
   * one final flush on session-end.
   */
  lastStatsFlushAt: number;
}

/**
 * The push/pull primitive used to feed user messages into the SDK's
 * streaming-input mode. Task 2 owns the implementation in
 * `session-manager.ts`; the type is exported here so Task 3 (which wires
 * the approval flow) and Task 6 (which calls `send()`) can refer to it.
 */
export interface SessionInputQueue {
  /** Enqueue one user-text turn. Resolves once the SDK has accepted it. */
  push: (userText: string) => void;
  /** Close the queue — the SDK iterator will end its prompt source. */
  close: () => void;
}
