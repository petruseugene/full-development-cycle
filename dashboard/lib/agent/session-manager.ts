/**
 * Session manager — singleton, lifecycle, NDJSON event log, disk metadata,
 * orphan detection (spec §4.1 R1–R5, R41).
 *
 * This module owns the Agent SDK `Query` for every per-feature chat
 * session. It is a process-wide singleton stashed on `globalThis` so it
 * survives Next.js dev-server HMR (R41).
 *
 * Responsibilities (Task 2 — core only):
 *  - `start(featureId)`            — spawn an SDK session, persist metadata
 *  - `resume(featureId)`           — re-attach to a persisted sessionId
 *  - `send(featureId, userText)`   — push into the SDK's streaming input
 *  - `kill(featureId)`             — abort the iterator (non-destructive on logs)
 *  - `list()` / `get(featureId)`   — read in-memory + disk records
 *  - orphan detection on module load (R5)
 *
 * NOT in this task (reserved slots only):
 *  - `canUseTool` real wrapper, approval queue, allowlist  → Task 3
 *  - Stats accumulator + 5s snapshot                        → Task 4
 *  - HTTP/SSE routes                                        → Tasks 5–8
 *
 * Added by Task 7:
 *  - Process-wide `globalEvents` broadcaster fanning out
 *    `approval_request` / `approval_resolved` / `session_status` events
 *    tagged with `{ featureId, ... }` for the dashboard-wide
 *    `GET /api/agent/events` SSE stream (spec R14 / AC4).
 *
 * The `canUseTool` here is a placeholder that **always allows**, per the
 * task envelope's note that Task 3 replaces it.
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentEvent,
  ErrorEvent,
  SessionInputQueue,
  SessionMeta,
  SessionRecord,
  SessionStatus,
} from './types';

import {
  createApprovalState,
  type ApprovalDecision,
  type ApprovalState,
  type PendingApproval,
} from './approvals';
import {
  createSessionStats,
  ensureFileTouchStat,
  ensureSubagentStat,
  ensureToolCallStat,
  extractTouchPath,
  isEditTool,
  type SessionStats,
} from './stats';
import { assertSafeFeatureId } from './path-safety';

/** Sessions that already emitted an SDK `error` event this turn (R9). */
const turnErrorEmitted = new WeakSet<SessionRecord>();

/** Redact anything key-shaped and cap length before text reaches the client. */
export function sanitizeErrorDetail(text: string, max = 200): string {
  const redacted = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Paths                                                                  */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Runtime root for all dashboard session state. `dashboard/.runtime/` is
 * git-ignored (R20). All paths under this root are derived in one place
 * so tests / log rotation (Task 6) can mock the base.
 */
const SESSIONS_DIR = path.resolve(process.cwd(), '.runtime', 'sessions');

// Every per-feature path derivation funnels through these three
// helpers — `assertSafeFeatureId` runs on every call so a malicious
// `featureId` (path traversal, NUL injection, mixed slashes) can
// never reach the underlying `path.join`. Belt-and-braces with the
// route-level guard; future internal callers don't have to know
// the rule. See `path-safety.ts` for the validation contract.
const metaPath = (featureId: string): string =>
  path.join(SESSIONS_DIR, `${assertSafeFeatureId(featureId)}.json`);

const eventsPath = (featureId: string): string =>
  path.join(SESSIONS_DIR, `${assertSafeFeatureId(featureId)}.events.jsonl`);

const statsPath = (featureId: string): string =>
  path.join(SESSIONS_DIR, `${assertSafeFeatureId(featureId)}.stats.json`);

/** Resolves the cwd the SDK runs against — project root, not `dashboard/` (R17). */
function resolveSdkCwd(): string {
  return path.resolve(process.cwd(), '..');
}

/* ────────────────────────────────────────────────────────────────────── */
/* Constants                                                              */
/* ────────────────────────────────────────────────────────────────────── */

/** Max ring-buffer length per session (Constraints §5 Memory). */
const RING_BUFFER_CAP = 1000;

/**
 * Throttle window for `<featureId>.stats.json` writes (Task 4 / R7).
 * Events still accumulate in memory at full rate; the disk file is at
 * most this fresh while events stream. One additional flush fires on
 * session-end (kill / idle / errored) so the on-disk snapshot reflects
 * the final state.
 */
const STATS_FLUSH_INTERVAL_MS = 5_000;

/**
 * `Omit` over a union of object types collapses the union — we need a
 * distributive form so each member of `AgentEvent` keeps its own discriminant.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never;

/* ────────────────────────────────────────────────────────────────────── */
/* Streaming-input queue                                                  */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Internal push/pull bridge between `send()` and the SDK's streaming-input
 * mode. The SDK's `query({ prompt })` takes an `AsyncIterable<SDKUserMessage>`
 * — we wrap a buffer + pending-promise so callers can push without blocking.
 *
 * Closed by `kill()` or when the SDK reports completion.
 */
function createInputQueue(): SessionInputQueue & {
  iterator: () => AsyncIterable<SDKUserMessage>;
} {
  const buffer: SDKUserMessage[] = [];
  const waiters: Array<(msg: SDKUserMessage | null) => void> = [];
  let closed = false;

  function push(userText: string): void {
    if (closed) return;
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: userText },
      parent_tool_use_id: null,
    };
    const next = waiters.shift();
    if (next) {
      next(msg);
    } else {
      buffer.push(msg);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.(null);
    }
  }

  async function* iterator(): AsyncIterable<SDKUserMessage> {
    while (true) {
      if (buffer.length > 0) {
        yield buffer.shift() as SDKUserMessage;
        continue;
      }
      if (closed) return;
      const msg = await new Promise<SDKUserMessage | null>((resolve) => {
        waiters.push(resolve);
      });
      if (msg === null) return;
      yield msg;
    }
  }

  return { push, close, iterator };
}

/* ────────────────────────────────────────────────────────────────────── */
/* canUseTool wrapper (Task 3 — real approval queue)                       */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Narrow the `unknown` `approvals` slot (typed as `ApprovalSlot` in
 * `types.ts` to avoid coupling Task 2 to this module) back to the
 * concrete `ApprovalState`. Lazily creates the record on first access
 * so neither `start()` nor `resume()` has to know about it.
 */
function getApprovals(record: SessionRecord): ApprovalState {
  let s = record.approvals as ApprovalState | null;
  if (s === null || typeof s !== 'object' || !(s as ApprovalState).pending) {
    s = createApprovalState();
    record.approvals = s;
  }
  return s;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Stats accessors (Task 4)                                                */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Narrow the `unknown` `stats` slot back to `SessionStats`. Lazily
 * creates the snapshot rooted at `meta.startedAt` so callers can rely on
 * a non-null return without every event-handler having to do the dance.
 */
function getStatsRecord(record: SessionRecord): SessionStats {
  let s = record.stats as SessionStats | null;
  if (s === null || typeof s !== 'object' || typeof (s as SessionStats).startedAt !== 'string') {
    s = createSessionStats(record.meta.startedAt);
    record.stats = s;
  }
  return s;
}

/** Narrow the Task → subagent attribution slot. */
function getTaskAttribution(record: SessionRecord): Map<string, string> {
  let m = record.taskToolCallToSubagent as Map<string, string> | null;
  if (!(m instanceof Map)) {
    m = new Map<string, string>();
    record.taskToolCallToSubagent = m;
  }
  return m;
}

/** Narrow the in-flight tool-call timestamp slot. */
function getPendingToolCalls(record: SessionRecord): Map<string, number> {
  let m = record.pendingToolCalls as Map<string, number> | null;
  if (!(m instanceof Map)) {
    m = new Map<string, number>();
    record.pendingToolCalls = m;
  }
  return m;
}

/**
 * Coerce an arbitrary value (typically off a loosely-typed SDK
 * payload) to a finite number, or 0. Used by every stats accumulator
 * so missing or non-numeric fields land as 0 rather than NaN.
 */
function numberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Manager                                                                */
/* ────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────── */
/* Dashboard-wide event broadcaster (Task 7)                              */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Event types the process-wide `globalEvents` broadcaster fans out for
 * the dashboard-wide `GET /api/agent/events` SSE stream (spec R14 / AC4).
 *
 *  - `approval_request`  — a new `canUseTool` request needs a decision.
 *  - `approval_resolved` — a pending request was resolved (allow/deny).
 *  - `session_status`    — a session transitioned to running / idle /
 *                          awaiting_approval / errored / killed.
 *
 * Each payload is the underlying per-session event body tagged with
 * `{ featureId, ... }` so TopBar / PendingApprovalsPill subscribers can
 * route events without opening one SSE per feature.
 */
export type GlobalAgentEventType =
  | 'approval_request'
  | 'approval_resolved'
  | 'session_status';

class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private orphanScanComplete = false;
  /**
   * Process-wide broadcaster for dashboard-wide `/api/agent/events` (Task 7).
   *
   * Listeners attach with `globalEvents.on('approval_request' | 'approval_resolved'
   * | 'session_status', payload => …)`. Every payload carries `featureId` so
   * subscribers can filter or route without an extra lookup.
   *
   * Lives at the manager (not on `globalThis`) — the manager itself is the
   * `globalThis.__sessionManager` singleton (R41), so this emitter is
   * inherently process-wide and HMR-stable. Listener cap is raised because
   * each open `/api/agent/events` request adds three handlers.
   */
  readonly globalEvents = new EventEmitter();

  constructor() {
    this.globalEvents.setMaxListeners(100);
  }

  /**
   * Mark every metadata file in `dashboard/.runtime/sessions/` as
   * `status: 'orphaned'` (R5 / R42). Runs once at module load — server
   * restart kills all in-process sessions, so anything on disk is by
   * definition no longer alive.
   *
   * On-disk side effect: rewrites each `<featureId>.json` with
   * `status: 'orphaned'`.
   */
  async scanForOrphans(): Promise<void> {
    if (this.orphanScanComplete) return;
    this.orphanScanComplete = true;
    try {
      await fs.mkdir(SESSIONS_DIR, { recursive: true });
      const entries = await fs.readdir(SESSIONS_DIR);
      for (const name of entries) {
        if (!name.endsWith('.json') || name.endsWith('.events.jsonl')) continue;
        if (name.includes('.events.') || name.includes('.stats.')) continue;
        const file = path.join(SESSIONS_DIR, name);
        try {
          const raw = await fs.readFile(file, 'utf8');
          const meta = JSON.parse(raw) as SessionMeta;
          if (meta.status !== 'orphaned') {
            meta.status = 'orphaned';
            await fs.writeFile(file, JSON.stringify(meta, null, 2), 'utf8');
          }
        } catch {
          // Skip unreadable / non-JSON files silently — they're not ours.
        }
      }
    } catch {
      // Directory does not exist yet — first run with no prior sessions.
    }
  }

  /**
   * Spawn a new SDK session for `featureId` and send `/orchestrator` as
   * the first prompt (R1, R2). Captures the SDK-provided `session_id`
   * from the first iterated message, persists `<featureId>.json` (R3),
   * and starts a background task that demultiplexes SDK messages into
   * `AgentEvent`s — appended to the NDJSON log (R4), pushed onto the ring
   * buffer, and emitted over the in-memory fan-out.
   *
   * On-disk side effects:
   *   - creates `dashboard/.runtime/sessions/` if absent
   *   - writes `<featureId>.json` (overwrites any prior file)
   *   - appends to `<featureId>.events.jsonl` for the life of the session
   *
   * Returns once metadata is persisted; the consumer task runs detached.
   */
  async start(
    featureId: string,
  ): Promise<{ sessionId: string; status: SessionStatus }> {
    assertSafeFeatureId(featureId);
    if (this.sessions.has(featureId)) {
      throw new Error(`session_already_exists:${featureId}`);
    }
    await fs.mkdir(SESSIONS_DIR, { recursive: true });

    const cwd = resolveSdkCwd();
    const abort = new AbortController();
    const queue = createInputQueue();
    // Seed the SDK's input stream with the `/orchestrator` slash command
    // as the first user turn. Subsequent turns arrive via `send()`.
    queue.push('/orchestrator');

    const q = query({
      prompt: queue.iterator(),
      options: {
        cwd,
        canUseTool: this.makeCanUseTool(featureId),
        abortController: abort,
      },
    });

    const startedAt = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId: '',
      featureId,
      startedAt,
      lastEventAt: startedAt,
      status: 'running',
      cwd,
    };

    const record: SessionRecord = {
      meta,
      abort,
      query: q,
      inputQueue: queue,
      ringBuffer: [],
      emitter: new EventEmitter(),
      nextEventId: 1,
      approvals: createApprovalState(),
      stats: createSessionStats(startedAt),
      taskToolCallToSubagent: new Map<string, string>(),
      pendingToolCalls: new Map<string, number>(),
      lastStatsFlushAt: 0,
    };
    // Emitter fanout is one-to-many; raise the cap so multiple SSE
    // subscribers (browser reloads, dashboard-wide stream in Task 7)
    // don't trip Node's default 10-listener warning.
    record.emitter.setMaxListeners(50);
    this.sessions.set(featureId, record);

    // Wait for the first iterated message to capture session_id, then
    // persist metadata and continue consuming in the background.
    const sessionId = await this.captureSessionIdAndConsume(record);
    return { sessionId, status: record.meta.status };
  }

  /**
   * Re-attach to a persisted session by `sessionId` (R5, R10). Reads
   * `<featureId>.json` to recover the SDK-provided session id, then calls
   * `query({ prompt: '', options: { resume } })` per the SDK's documented
   * resume API.
   *
   * On-disk side effects:
   *   - rewrites `<featureId>.json` with `status: 'running'`
   *   - appends a `status` event with `phase: 'resumed'` to the NDJSON log
   */
  async resume(
    featureId: string,
  ): Promise<{ sessionId: string; status: SessionStatus }> {
    assertSafeFeatureId(featureId);
    const live = this.sessions.get(featureId);
    if (live && live.meta.status !== 'errored') {
      // Already alive — nothing to resume.
      return { sessionId: live.meta.sessionId, status: live.meta.status };
    }
    if (live) {
      // L13 — a live record marked errored (SDK error) is a dead end for
      // send(); Retry must restart it. Tear it down, then fall through to
      // the persisted-meta resume below.
      live.abort.abort();
      live.inputQueue?.close();
      try {
        live.query?.close();
      } catch {
        // SDK may throw if already closed — swallow.
      }
      this.sessions.delete(featureId);
    }
    const persisted = await this.readMeta(featureId);
    if (!persisted) {
      throw new Error(`no_session_to_resume:${featureId}`);
    }

    const cwd = persisted.cwd;
    const abort = new AbortController();
    const queue = createInputQueue();
    const q = query({
      prompt: queue.iterator(),
      options: {
        cwd,
        resume: persisted.sessionId,
        canUseTool: this.makeCanUseTool(featureId),
        abortController: abort,
      },
    });

    const meta: SessionMeta = {
      ...persisted,
      status: 'running',
      lastEventAt: new Date().toISOString(),
    };
    const record: SessionRecord = {
      meta,
      abort,
      query: q,
      inputQueue: queue,
      ringBuffer: [],
      emitter: new EventEmitter(),
      nextEventId: 1,
      approvals: null,
      // On resume we restart the stats accumulator from `now` — the
      // previous run's stats file remains on disk for history but the
      // in-memory snapshot is fresh, mirroring the SDK's "new turn"
      // semantics. wallClockMs ticks from the resume timestamp.
      stats: createSessionStats(meta.lastEventAt),
      taskToolCallToSubagent: new Map<string, string>(),
      pendingToolCalls: new Map<string, number>(),
      lastStatsFlushAt: 0,
    };
    record.emitter.setMaxListeners(50);
    this.sessions.set(featureId, record);

    await this.persistMeta(record);
    this.emitEvent(record, {
      type: 'status',
      status: 'running',
      phase: 'resumed',
    });

    // Kick off the consumer in the background; resume does not need to
    // wait for the first message (session_id is already known).
    void this.consumeIterator(record);

    return { sessionId: meta.sessionId, status: meta.status };
  }

  /**
   * Forward `userText` into the SDK's streaming input (R1, R11). Returns
   * an object describing whether the message was accepted; the caller
   * (Task 6's `/message` route) maps non-acceptance to HTTP body shape.
   *
   * On-disk side effect: none directly — the SDK echoes the user turn
   * back as a `user` SDKMessage, which the consumer task observes and
   * (currently) ignores. (Echoing user text into the chat log is a
   * frontend concern, handled optimistically client-side.)
   */
  send(
    featureId: string,
    userText: string,
  ): { accepted: true } | { accepted: false; reason: string } {
    assertSafeFeatureId(featureId);
    const record = this.sessions.get(featureId);
    if (!record || !record.inputQueue) {
      return { accepted: false, reason: 'no_active_session' };
    }
    if (record.meta.status === 'killed' || record.meta.status === 'errored') {
      return {
        accepted: false,
        reason: `session_${record.meta.status}`,
      };
    }
    if (userText.trim().length === 0) {
      return { accepted: false, reason: 'empty_message' };
    }
    record.inputQueue.push(userText);
    return { accepted: true };
  }

  /**
   * Terminate the session by aborting the controller and closing the
   * input queue, then mark status `killed` and emit a final `status`
   * event (R13, R43).
   *
   * On-disk side effect: rewrites `<featureId>.json` with
   * `status: 'killed'`. Does NOT delete or rotate any log file — log
   * rotation happens at the next `start()` call (per Task 6), not here.
   */
  async kill(featureId: string): Promise<{ killed: boolean }> {
    assertSafeFeatureId(featureId);
    const record = this.sessions.get(featureId);
    if (!record) return { killed: false };

    record.abort.abort();
    record.inputQueue?.close();
    try {
      record.query?.close();
    } catch {
      // SDK may throw if already closed — swallow.
    }
    record.meta.status = 'killed';
    record.meta.lastEventAt = new Date().toISOString();
    await this.persistMeta(record);
    this.emitEvent(record, {
      type: 'status',
      status: 'killed',
      phase: 'killed',
    });
    // Final stats snapshot to disk before we detach (R7 — "and once
    // more on session-end"). Force-flush bypasses the 5 s throttle.
    this.maybeFlushStats(record, true);
    // Detach the in-memory record so a follow-up start() is free to
    // spawn a fresh session. Disk state remains for log rotation /
    // history review (R43).
    this.sessions.delete(featureId);
    return { killed: true };
  }

  /**
   * Returns the in-memory snapshot for `featureId`, falling back to disk
   * metadata if the session is not live. Returns `null` when neither
   * source has a record.
   *
   * On-disk side effect: none — pure read.
   */
  async get(featureId: string): Promise<SessionRecord | SessionMeta | null> {
    assertSafeFeatureId(featureId);
    const live = this.sessions.get(featureId);
    if (live) return live;
    return await this.readMeta(featureId);
  }

  /**
   * Enumerate every known session — in-memory live records plus disk-only
   * orphaned metadata. Used by Task 7's `/api/agent/approvals` aggregator
   * and by any future cross-feature UI.
   *
   * On-disk side effect: none.
   */
  async list(): Promise<Array<SessionRecord | SessionMeta>> {
    const out: Array<SessionRecord | SessionMeta> = [];
    const seen = new Set<string>();
    for (const r of this.sessions.values()) {
      out.push(r);
      seen.add(r.meta.featureId);
    }
    try {
      const entries = await fs.readdir(SESSIONS_DIR);
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        if (name.includes('.events.') || name.includes('.stats.')) continue;
        const featureId = name.slice(0, -'.json'.length);
        if (seen.has(featureId)) continue;
        // Skip any on-disk filename that does not satisfy our id rule
        // (e.g. a stale rotated file with a `.` prefix, or anything an
        // earlier unpatched build wrote). Defensive: readMeta() would
        // also reject via metaPath()'s assertSafeFeatureId, but checking
        // here avoids the throw entirely.
        try {
          assertSafeFeatureId(featureId);
        } catch {
          continue;
        }
        const meta = await this.readMeta(featureId);
        if (meta) out.push(meta);
      }
    } catch {
      // No sessions dir yet.
    }
    return out;
  }

  /* ──────────────────────────────────────────────────────────────────── */
  /* Approvals (Task 3)                                                   */
  /* ──────────────────────────────────────────────────────────────────── */

  /**
   * Resolve a pending `canUseTool` request for `featureId` with the
   * caller's `decision` (spec R6 / R12). Settles the awaited Promise
   * stored in `ApprovalState.pending`, emits an `approval_resolved`
   * event, and — when no approvals remain and the session is still
   * alive — flips status back to `'running'`.
   *
   * Throws when the session is unknown OR the `requestId` is not
   * pending; Task 7's HTTP handler maps the throw to `404
   * { error: 'unknown_request' }`.
   *
   * On-disk side effect: rewrites `<featureId>.json` only when the
   * status transition from `awaiting_approval` → `running` fires.
   * The NDJSON log gains one `approval_resolved` line and, on the
   * status flip, one `status` line.
   */
  async respondApproval(
    featureId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<{ resolved: true }> {
    assertSafeFeatureId(featureId);
    const record = this.sessions.get(featureId);
    if (!record) {
      throw new Error(`unknown_request:${requestId}`);
    }
    const state = getApprovals(record);
    const entry = state.pending.get(requestId);
    if (!entry) {
      throw new Error(`unknown_request:${requestId}`);
    }

    // Settle the awaited canUseTool Promise. Both 'allow' variants
    // echo `toolInput` back as `updatedInput` per the SDK contract;
    // 'allow_and_remember' additionally adds the tool to the
    // remember-allowlist so the next call short-circuits.
    if (decision === 'allow' || decision === 'allow_and_remember') {
      if (decision === 'allow_and_remember') {
        state.allowlist.add(entry.toolName);
      }
      entry.resolve({ behavior: 'allow', updatedInput: entry.toolInput });
    } else {
      entry.resolve({
        behavior: 'deny',
        message: 'User denied permission',
      });
    }
    state.pending.delete(requestId);

    this.emitEvent(record, {
      type: 'approval_resolved',
      requestId,
      decision,
    });

    // If the pending queue is empty and the session is still alive,
    // flip status back to `'running'` and emit a status event so the
    // frontend re-enables the reply composer (R30).
    if (
      state.pending.size === 0 &&
      record.meta.status === 'awaiting_approval'
    ) {
      record.meta.status = 'running';
      record.meta.lastEventAt = new Date().toISOString();
      await this.persistMeta(record);
      this.emitEvent(record, {
        type: 'status',
        status: 'running',
        phase: 'started',
      });
    }

    return { resolved: true };
  }

  /**
   * Flatten every active session's pending approvals into a single
   * array (R14 / Task 7's `GET /api/agent/approvals` aggregator).
   *
   * Disk-only / orphaned sessions never carry pending approvals
   * (their in-memory `pending` map is gone with the process), so this
   * method only walks the in-memory map.
   */
  listPendingApprovals(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const record of this.sessions.values()) {
      const state = getApprovals(record);
      for (const [id, entry] of state.pending) {
        out.push({
          id,
          featureId: record.meta.featureId,
          toolName: entry.toolName,
          toolInput: entry.toolInput,
          createdAt: entry.createdAt,
        });
      }
    }
    return out;
  }

  /* ──────────────────────────────────────────────────────────────────── */
  /* Stats (Task 4)                                                       */
  /* ──────────────────────────────────────────────────────────────────── */

  /**
   * Public snapshot accessor (Task 4 → Task 8).
   *
   * Returns the in-memory `SessionStats` for `featureId` with
   * `wallClockMs` recomputed against `Date.now()` so a slow flush
   * never leaks a stale value to the API. Returns `null` when the
   * session is not live (the route maps that to `200 {}` per Task 8).
   *
   * The returned object is a SHALLOW clone of the inner accumulator —
   * the caller can serialise it without worrying about the next
   * `accumulate*` call mutating fields underneath them. Deep-copying
   * `Record<string, T>` children is unnecessary because the route
   * `JSON.stringify`s the result before returning.
   */
  getStats(featureId: string): SessionStats | null {
    assertSafeFeatureId(featureId);
    const record = this.sessions.get(featureId);
    if (!record) return null;
    const stats = getStatsRecord(record);
    const startedMs = Date.parse(stats.startedAt);
    const wallClockMs = Number.isFinite(startedMs)
      ? Math.max(0, Date.now() - startedMs)
      : 0;
    stats.wallClockMs = wallClockMs;
    return {
      ...stats,
      // Shallow copies of the keyed-records so callers don't pin
      // mutable references to live counters.
      toolCalls: { ...stats.toolCalls },
      filesTouched: { ...stats.filesTouched },
      subagents: { ...stats.subagents },
    };
  }

  /**
   * Fold a `tool_call` block into the stats accumulator:
   *  - bump `toolCalls[toolName].count`
   *  - record start timestamp for duration matching (matches the
   *    paired `tool_result` in `accumulateToolResult`)
   *  - on `Task` tool dispatch → bump `subagents[type].dispatches`
   *    and remember the `tool_use_id` → `subagent_type` mapping so
   *    the matching `tool_result` can attribute usage / cost / duration
   *  - on Read / Edit / Write / NotebookEdit / Glob / Grep → bump the
   *    `filesTouched` ledger
   *
   * All work is best-effort; missing fields land as 0/null and never
   * throw (R7 — "Missing fields are NOT errors").
   */
  private accumulateToolCall(
    record: SessionRecord,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const stats = getStatsRecord(record);
    const ts = new Date().toISOString();

    // Per-tool counter.
    ensureToolCallStat(stats, toolName).count += 1;

    // Track start time for duration calculation. The `tool_use_id`
    // is the only stable handle across the call/result pair.
    if (toolUseId) {
      getPendingToolCalls(record).set(toolUseId, Date.now());
    }

    // Subagent dispatch.
    if (toolName === 'Task') {
      const subagentType =
        typeof input.subagent_type === 'string' && input.subagent_type.length > 0
          ? input.subagent_type
          : 'unknown';
      ensureSubagentStat(stats, subagentType).dispatches += 1;
      if (toolUseId) {
        getTaskAttribution(record).set(toolUseId, subagentType);
      }
    }

    // Path-bearing tools — Read/Glob/Grep bump reads, Edit/Write/NotebookEdit bump edits.
    const touchPath = extractTouchPath(toolName, input);
    if (touchPath !== null) {
      const fileStat = ensureFileTouchStat(stats, touchPath, ts);
      if (isEditTool(toolName)) {
        fileStat.edits += 1;
      } else {
        fileStat.reads += 1;
      }
      fileStat.lastTouchedAt = ts;
    }
  }

  /**
   * Fold a `tool_result` block into the stats accumulator. Pairs with
   * a prior `accumulateToolCall` via `toolUseId`:
   *  - if the call was a `Task` dispatch → parse the result body for
   *    optional `usage` / `total_cost_usd` / `duration_ms` and roll
   *    into `subagents[type]`. Missing fields stay at 0.
   *  - duration: compute `Date.now() - startedAt(ms)` and add to the
   *    matching `toolCalls[toolName].totalDurationMs`. We don't have
   *    `toolName` here, so we look it up via the pending map by
   *    deriving from the subagent attribution OR scanning the ring
   *    buffer for the matching `tool_call` (cheap — bounded by 1000).
   *
   * `raw` is the SDK's `tool_use_result` payload — shape varies per
   * tool, so all reads are defensive.
   */
  private accumulateToolResult(
    record: SessionRecord,
    toolUseId: string,
    raw: unknown,
  ): void {
    if (!toolUseId) return;
    const stats = getStatsRecord(record);
    const pending = getPendingToolCalls(record);
    const startedAtMs = pending.get(toolUseId);
    const completedAtMs = Date.now();
    const durationMs =
      typeof startedAtMs === 'number' ? completedAtMs - startedAtMs : 0;

    // Per-tool duration. We resolve toolName by walking the ring
    // buffer backwards — the matching `tool_call` is almost always
    // very recent. Bounded by RING_BUFFER_CAP so worst-case is O(1000).
    if (durationMs > 0) {
      for (let i = record.ringBuffer.length - 1; i >= 0; i--) {
        const ev = record.ringBuffer[i];
        if (ev.type === 'tool_call' && ev.toolUseId === toolUseId) {
          ensureToolCallStat(stats, ev.toolName).totalDurationMs += durationMs;
          break;
        }
      }
    }
    pending.delete(toolUseId);

    // Subagent attribution. If this result pairs with a `Task` call,
    // fold any embedded usage / cost / duration into the ledger.
    const attribution = getTaskAttribution(record);
    const subagentType = attribution.get(toolUseId);
    if (!subagentType) return;
    attribution.delete(toolUseId);

    const ledger = ensureSubagentStat(stats, subagentType);
    // The SDK exposes the subagent's totals on the result body in one
    // of a few shapes. Probe the common ones; missing → 0.
    const body = raw as
      | {
          usage?: {
            input_tokens?: unknown;
            output_tokens?: unknown;
            cache_creation_input_tokens?: unknown;
            cache_read_input_tokens?: unknown;
          };
          total_cost_usd?: unknown;
          duration_ms?: unknown;
        }
      | null
      | undefined;
    const usage = body?.usage ?? {};
    ledger.inputTokens += numberOr0(usage.input_tokens);
    ledger.outputTokens += numberOr0(usage.output_tokens);
    ledger.cacheCreationTokens += numberOr0(usage.cache_creation_input_tokens);
    ledger.cacheReadTokens += numberOr0(usage.cache_read_input_tokens);
    ledger.costUsd += numberOr0(body?.total_cost_usd);
    // Prefer the SDK-reported `duration_ms`; fall back to our wall-
    // clock measurement so the column is never blank.
    const sdkDuration = numberOr0(body?.duration_ms);
    ledger.durationMs += sdkDuration > 0 ? sdkDuration : durationMs;
  }

  /**
   * Throttled write of `<featureId>.stats.json` — at most one write
   * per `STATS_FLUSH_INTERVAL_MS`. The session-end paths (kill /
   * idle / errored) force one final flush so the on-disk snapshot
   * matches the in-memory state.
   *
   * Fire-and-forget: a slow disk must never back-pressure the
   * iterator-consumer loop.
   */
  private maybeFlushStats(record: SessionRecord, force = false): void {
    const now = Date.now();
    if (!force && now - record.lastStatsFlushAt < STATS_FLUSH_INTERVAL_MS) {
      return;
    }
    record.lastStatsFlushAt = now;
    void this.flushStats(record);
  }

  /**
   * Serialize `<featureId>.stats.json`. Computes a fresh `wallClockMs`
   * relative to `startedAt` so the disk snapshot is also live for any
   * out-of-process reader.
   *
   * Atomic via `write tmp → rename`, same pattern as `persistMeta`.
   * Errors are logged but never re-thrown — losing a snapshot is
   * preferable to crashing the consumer.
   */
  private async flushStats(record: SessionRecord): Promise<void> {
    const stats = getStatsRecord(record);
    const startedMs = Date.parse(stats.startedAt);
    const wallClockMs = Number.isFinite(startedMs)
      ? Math.max(0, Date.now() - startedMs)
      : 0;
    const snapshot: SessionStats = { ...stats, wallClockMs };
    const file = statsPath(record.meta.featureId);
    const tmp = `${file}.tmp`;
    try {
      await fs.mkdir(SESSIONS_DIR, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[session-manager] stats.json flush failed', err);
    }
  }

  /**
   * Build the per-session `canUseTool` callback the SDK invokes before
   * every tool-use (spec R6). The closure binds to `featureId` so the
   * SDK can call the same function across many tools while the
   * wrapper still resolves the right `ApprovalState`.
   *
   * Flow:
   *  1. Allowlist hit → `{ behavior: 'allow', updatedInput: input }`
   *     immediately, no event emitted.
   *  2. Miss → mint `requestId`, store the Promise's settlers in
   *     `pending`, flip status `awaiting_approval`, emit
   *     `approval_request`, return the awaited Promise.
   *  3. `signal.aborted` (kill mid-approval) → reject with an Error;
   *     the SDK treats Promise rejection as a deny. The pending entry
   *     is also cleaned up so a follow-up resume() doesn't see ghost
   *     requests.
   *
   * The wrapper never mutates `input`; the SDK contract requires
   * `updatedInput` even on plain allows, so we echo it back verbatim.
   */
  private makeCanUseTool(featureId: string): CanUseTool {
    return (toolName, input, options): Promise<PermissionResult> => {
      const record = this.sessions.get(featureId);
      // Defensive: a tool call should never fire after the record is
      // gone (kill() aborts the controller first), but if it does,
      // deny rather than hang the SDK on a Promise that nobody can
      // resolve.
      if (!record) {
        return Promise.resolve({
          behavior: 'deny',
          message: 'session_gone',
        });
      }
      const state = getApprovals(record);

      // (1) Allowlist short-circuit. No event — silent allow per R6.
      if (state.allowlist.has(toolName)) {
        return Promise.resolve({ behavior: 'allow', updatedInput: input });
      }

      // (2) Real approval. Build the Promise first so we capture both
      // settlers atomically before we publish the request id.
      const requestId = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      const promise = new Promise<PermissionResult>((resolve, reject) => {
        state.pending.set(requestId, {
          toolName,
          toolInput: input,
          createdAt,
          resolve,
          reject,
        });
      });

      // Flip session status to `awaiting_approval` (R30 — frontend
      // composer disables on this status). The transition only fires
      // when we move FROM a live state; if we're already mid-approval
      // (multi-tool turn) we don't re-emit.
      if (
        record.meta.status === 'running' ||
        record.meta.status === 'idle'
      ) {
        record.meta.status = 'awaiting_approval';
        record.meta.lastEventAt = createdAt;
        // Fire-and-forget — persistMeta() is async but we don't want
        // to block the canUseTool wrapper on disk I/O. Worst case the
        // disk-state lags the in-memory state by milliseconds.
        void this.persistMeta(record);
      }

      this.emitEvent(record, {
        type: 'approval_request',
        requestId,
        toolName,
        toolInput: input,
        createdAt,
      });

      // (3) Abort wiring. If the SDK's signal fires mid-approval
      // (typically because kill() ran), reject the Promise — the SDK
      // treats a rejection as a deny — and remove the pending entry
      // so listPendingApprovals() never reports a ghost.
      const onAbort = (): void => {
        const entry = state.pending.get(requestId);
        if (!entry) return;
        state.pending.delete(requestId);
        entry.reject(new Error('aborted'));
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      return promise;
    };
  }

  /* ──────────────────────────────────────────────────────────────────── */
  /* Internals                                                            */
  /* ──────────────────────────────────────────────────────────────────── */

  /**
   * Drive the SDK iterator long enough to capture the first `session_id`,
   * write metadata, then hand off to the background consumer.
   *
   * Returns the captured sessionId so `start()` can return it to its
   * caller (which is what the `/start` route forwards to the browser).
   */
  private async captureSessionIdAndConsume(
    record: SessionRecord,
  ): Promise<string> {
    const q = record.query;
    if (!q) throw new Error('no_query_handle');

    // Pull the first SDK message synchronously so the start() promise
    // resolves with a usable session_id. The remaining messages are
    // processed by `consumeIterator()`, which we kick off below.
    const first = await q.next();
    if (first.done) {
      // SDK exited before yielding anything — treat as error.
      record.meta.status = 'errored';
      await this.persistMeta(record);
      this.emitEvent(record, {
        type: 'error',
        message: 'sdk_exited_before_first_message',
        retryable: false,
      });
      this.sessions.delete(record.meta.featureId);
      throw new Error('sdk_exited_before_first_message');
    }
    const msg = first.value as SDKMessage;
    const sessionId = (msg as { session_id?: string }).session_id;
    if (!sessionId) {
      throw new Error('first_message_missing_session_id');
    }
    record.meta.sessionId = sessionId;
    await this.persistMeta(record);
    this.emitEvent(record, {
      type: 'status',
      status: 'running',
      phase: 'started',
    });
    // Hand the first message to the demuxer so it is logged like any
    // other event, then continue draining in the background.
    this.handleSdkMessage(record, msg);
    void this.consumeIterator(record);
    return sessionId;
  }

  /**
   * Background drain loop — pulls every remaining SDK message from the
   * iterator, demultiplexes it into `AgentEvent`s, appends to the NDJSON
   * log (R4), pushes onto the ring buffer (R8), and emits over the
   * fan-out emitter. Runs until the SDK iterator completes or the abort
   * signal fires.
   */
  private async consumeIterator(record: SessionRecord): Promise<void> {
    const q = record.query;
    if (!q) return;
    try {
      for await (const msg of q) {
        if (record.abort.signal.aborted) break;
        this.handleSdkMessage(record, msg);
      }
      // SDK ran to completion — chat remains usable for follow-up
      // messages (R44). Flip status to idle.
      if (record.meta.status !== 'killed' && record.meta.status !== 'errored') {
        record.meta.status = 'idle';
        record.meta.lastEventAt = new Date().toISOString();
        await this.persistMeta(record);
        this.emitEvent(record, {
          type: 'status',
          status: 'idle',
          phase: 'idle',
        });
        // Final flush on idle (R7 — "and once more on session-end").
        this.maybeFlushStats(record, true);
      }
    } catch (err) {
      if (record.abort.signal.aborted) return; // kill() path
      record.meta.status = 'errored';
      record.meta.lastEventAt = new Date().toISOString();
      await this.persistMeta(record);
      this.emitEvent(record, {
        type: 'error',
        message: sanitizeErrorDetail(
          err instanceof Error ? err.message : String(err),
        ),
        retryable: true,
      });
      // Final flush on error too — the partial accumulator is more
      // useful to the user than nothing.
      this.maybeFlushStats(record, true);
    }
  }

  /**
   * Demultiplex one `SDKMessage` into zero or more `AgentEvent`s.
   *
   * Mapping (covers the message types the dashboard actually surfaces;
   * unrecognised types are silently ignored — the SDK adds new message
   * variants periodically and we don't want to crash the consumer):
   *   - SDKAssistantMessage  → `assistant_text` per text block,
   *                            `tool_call` per tool_use block
   *   - SDKUserMessage       → `tool_result` when the user content
   *                            includes a `tool_result` block (the SDK
   *                            re-routes tool results through a user
   *                            message frame)
   *   - SDKResultMessage     → terminal `usage` event with totals
   *   - SDKSystemMessage     → init / log frames; not surfaced
   *
   * Approval events (`approval_request` / `approval_resolved`) are NOT
   * produced here — those originate from Task 3's canUseTool wrapper.
   */
  private handleSdkMessage(record: SessionRecord, msg: SDKMessage): void {
    record.meta.lastEventAt = new Date().toISOString();

    switch (msg.type) {
      case 'assistant':
        this.handleAssistant(record, msg as SDKAssistantMessage);
        break;
      case 'user':
        this.handleUser(record, msg as SDKUserMessage);
        break;
      case 'result':
        this.handleResult(record, msg as SDKResultMessage);
        break;
      case 'system':
        // System frames (init, log) are not user-visible. Intentionally
        // dropped so the chat log stays clean.
        void (msg as SDKSystemMessage);
        break;
      default:
        // Unknown / future message types — ignore silently.
        break;
    }
  }

  private handleAssistant(
    record: SessionRecord,
    msg: SDKAssistantMessage,
  ): void {
    const messageId =
      (msg.message as { id?: string }).id ?? `msg_${record.nextEventId}`;
    const content = (msg.message as { content?: unknown[] }).content ?? [];
    // SDK-reported error (billing, auth, ...): surface as one `error`
    // event instead of a plain assistant bubble (R9).
    const sdkError = (msg as { error?: string }).error;
    if (sdkError) {
      const text = content
        .filter((b) => (b as { type?: string }).type === 'text')
        .map((b) => (b as { text?: string }).text ?? '')
        .join('')
        .trim();
      this.emitSdkError(record, sdkError, text);
      return;
    }
    // One assistant message === one conversational turn (R7, AC5).
    // Bumped here rather than per-block so a multi-tool-call turn still
    // only counts as one.
    const stats = getStatsRecord(record);
    stats.turns += 1;
    for (const block of content) {
      const b = block as { type?: string };
      if (b.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text.length > 0) {
          this.emitEvent(record, {
            type: 'assistant_text',
            messageId,
            delta: text,
          });
        }
      } else if (b.type === 'tool_use') {
        const tu = block as {
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        };
        const toolUseId = tu.id ?? '';
        const toolName = tu.name ?? 'unknown';
        const input = tu.input ?? {};
        this.accumulateToolCall(record, toolUseId, toolName, input);
        this.emitEvent(record, {
          type: 'tool_call',
          toolUseId,
          toolName,
          input,
        });
      }
    }
    this.maybeFlushStats(record);
    // Mark the end of this assistant message so the frontend can flush
    // the streaming-text block (R27 assistant_text bullet).
    this.emitEvent(record, {
      type: 'status',
      status: record.meta.status,
      phase: 'message_end',
    });
  }

  private handleUser(record: SessionRecord, msg: SDKUserMessage): void {
    // The SDK frames tool results inside a user-role message whose
    // `content` is an array containing `tool_result` blocks. Other
    // user messages (the ones we pushed via send()) are echoed back and
    // do not need to be re-rendered server-side.
    const content = (msg.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as { type?: string };
      if (b.type !== 'tool_result') continue;
      const tr = block as {
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      const toolUseId = tr.tool_use_id ?? '';
      const text = this.flattenResultContent(tr.content);
      // Accumulate tool-call duration + subagent attribution BEFORE we
      // emit so the stats snapshot is in sync with whatever the SSE
      // subscriber observes (Task 4).
      this.accumulateToolResult(record, toolUseId, msg.tool_use_result);
      this.emitEvent(record, {
        type: 'tool_result',
        toolUseId,
        content: text,
        isError: tr.is_error === true,
        raw: msg.tool_use_result,
      });
    }
    this.maybeFlushStats(record);
  }

  private flattenResultContent(c: unknown): string {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((part) => {
          const p = part as { type?: string; text?: string };
          if (p.type === 'text' && typeof p.text === 'string') return p.text;
          return '';
        })
        .join('');
    }
    return '';
  }

  /**
   * Emit one `error` event for an SDK-reported error and mark the session
   * errored. Records that an error was emitted this turn so `handleResult`
   * does not emit a second one.
   */
  private emitSdkError(
    record: SessionRecord,
    code: string,
    text: string,
  ): void {
    const known: ReadonlyArray<NonNullable<ErrorEvent['code']>> = [
      'billing_error',
      'authentication_failed',
      'rate_limit',
      'invalid_request',
      'server_error',
      'max_output_tokens',
      'oauth_org_not_allowed',
      'unknown',
    ];
    const c = (known as readonly string[]).includes(code)
      ? (code as NonNullable<ErrorEvent['code']>)
      : 'unknown';
    let message: string;
    if (c === 'billing_error') {
      message =
        'API credit balance too low — top up at https://platform.claude.com/settings/billing, then Retry.';
    } else if (c === 'authentication_failed') {
      message = 'API key rejected — check ANTHROPIC_API_KEY.';
    } else {
      message = sanitizeErrorDetail(text || code);
    }
    turnErrorEmitted.add(record);
    if (record.meta.status !== 'killed') {
      record.meta.status = 'errored';
      record.meta.lastEventAt = new Date().toISOString();
      void this.persistMeta(record);
    }
    const retryable = c !== 'authentication_failed' && c !== 'invalid_request';
    this.emitEvent(record, { type: 'error', code: c, message, retryable });
    this.emitEvent(record, {
      type: 'status',
      status: 'errored',
      phase: 'errored',
    });
  }

  private handleResult(record: SessionRecord, msg: SDKResultMessage): void {
    const alreadyErrored = turnErrorEmitted.delete(record);
    const rm = msg as unknown as {
      is_error?: boolean;
      result?: string;
      errors?: string[];
    };
    if (rm.is_error && !alreadyErrored) {
      this.emitSdkError(
        record,
        'unknown',
        (typeof rm.result === 'string' && rm.result) || rm.errors?.[0] || '',
      );
      turnErrorEmitted.delete(record);
    }
    const m = msg as unknown as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      total_cost_usd?: number;
    };
    const usage = m.usage ?? {};
    const inputTokens = numberOr0(usage.input_tokens);
    const outputTokens = numberOr0(usage.output_tokens);
    const cacheCreationTokens = numberOr0(usage.cache_creation_input_tokens);
    const cacheReadTokens = numberOr0(usage.cache_read_input_tokens);
    const costUsd = numberOr0(m.total_cost_usd);

    // Fold the top-level usage into the per-session stats accumulator
    // (R7 — usage events). Subagent attribution is handled separately
    // in accumulateToolResult().
    const stats = getStatsRecord(record);
    stats.inputTokens += inputTokens;
    stats.outputTokens += outputTokens;
    stats.cacheCreationTokens += cacheCreationTokens;
    stats.cacheReadTokens += cacheReadTokens;
    stats.costUsd += costUsd;

    this.emitEvent(record, {
      type: 'usage',
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUsd,
    });
    this.maybeFlushStats(record);
  }

  /**
   * Stamp `id` + `ts`, push to the ring buffer (capped at 1000), append
   * one NDJSON line to `<featureId>.events.jsonl`, and fan out over the
   * in-memory emitter under the `'event'` topic.
   *
   * The NDJSON append is fire-and-forget: append-only writes to the
   * same fd are safely interleaved at the kernel level on POSIX, and we
   * don't want a slow disk to back-pressure the SSE fanout. Errors are
   * logged once but never re-thrown — losing a log line is preferable
   * to crashing the consumer.
   */
  private emitEvent(
    record: SessionRecord,
    base: DistributiveOmit<AgentEvent, 'id' | 'ts'>,
  ): void {
    const ev: AgentEvent = {
      ...base,
      id: record.nextEventId++,
      ts: new Date().toISOString(),
    } as AgentEvent;
    record.ringBuffer.push(ev);
    if (record.ringBuffer.length > RING_BUFFER_CAP) {
      record.ringBuffer.shift();
    }
    record.emitter.emit('event', ev);
    void this.appendEventLine(record.meta.featureId, ev);
    // Process-wide broadcast for Task 7's dashboard-wide /events SSE
    // stream. We piggy-back on the existing per-session event log — no
    // duplicate persistence, no extra ring buffer. `status` events are
    // re-tagged as `session_status` so subscribers can filter cleanly.
    this.broadcastGlobal(record.meta.featureId, ev);
  }

  /**
   * Fan out the subset of per-session events the dashboard-wide
   * `GET /api/agent/events` SSE stream cares about (Task 7 / R14 / AC4).
   *
   * Wraps the original event with a `featureId` tag and re-keys
   * `status` → `session_status` so `globalEvents` subscribers can
   * `globalEvents.on('session_status', ...)` without colliding with
   * future per-session topic names.
   *
   * Fire-and-forget: emitter dispatch is synchronous + in-process; a
   * misbehaving listener cannot back-pressure this path because the
   * outer `emitEvent` already completed its persistence work.
   */
  private broadcastGlobal(featureId: string, ev: AgentEvent): void {
    if (ev.type === 'approval_request' || ev.type === 'approval_resolved') {
      this.globalEvents.emit(ev.type, { featureId, ...ev });
      return;
    }
    if (ev.type === 'status') {
      this.globalEvents.emit('session_status', { featureId, ...ev });
    }
  }

  private async appendEventLine(
    featureId: string,
    ev: AgentEvent,
  ): Promise<void> {
    try {
      await fs.appendFile(eventsPath(featureId), JSON.stringify(ev) + '\n');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[session-manager] events.jsonl append failed', err);
    }
  }

  /** Read `<featureId>.json` from disk; returns `null` if missing. */
  private async readMeta(featureId: string): Promise<SessionMeta | null> {
    try {
      const raw = await fs.readFile(metaPath(featureId), 'utf8');
      return JSON.parse(raw) as SessionMeta;
    } catch {
      return null;
    }
  }

  /**
   * Write `<featureId>.json` atomically — write to a tmp path, rename.
   * Atomic rename avoids a half-written file confusing a concurrent
   * `list()` / `get()` read.
   */
  private async persistMeta(record: SessionRecord): Promise<void> {
    const file = metaPath(record.meta.featureId);
    const tmp = `${file}.tmp`;
    const body = JSON.stringify(record.meta, null, 2);
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, file);
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* Singleton (R41 — survives Next.js HMR)                                 */
/* ────────────────────────────────────────────────────────────────────── */

const SINGLETON_KEY = '__sessionManager' as const;

interface SessionManagerGlobal {
  [SINGLETON_KEY]?: SessionManager;
}

function getOrCreateManager(): SessionManager {
  const g = globalThis as unknown as SessionManagerGlobal;
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = new SessionManager();
    // Fire-and-forget orphan scan on first module load (R5). Subsequent
    // HMR re-imports return the same instance and skip the scan.
    void g[SINGLETON_KEY]!.scanForOrphans();
  }
  return g[SINGLETON_KEY]!;
}

export const sessionManager = getOrCreateManager();
export type { SessionManager };
