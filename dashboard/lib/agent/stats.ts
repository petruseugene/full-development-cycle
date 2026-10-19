/**
 * Per-session stats accumulator (Task 4 / spec R7 / AC5).
 *
 * The session manager attaches one `SessionStats` record to every
 * `SessionRecord` and folds each observed `AgentEvent` into it. The
 * resulting snapshot is what `GET /api/agent/[featureId]/stats`
 * (Task 8) returns to the frontend Stats tab (Task 15) every 3s.
 *
 * Design notes:
 *  - Pure data + a factory. No I/O here. The session-manager owns the
 *    throttled flush to `<featureId>.stats.json`.
 *  - All counters start at 0 / empty so the API can return the object
 *    unmodified for a brand-new session.
 *  - `subagents` is keyed by `subagent_type` (e.g. `frontend-dev`,
 *    `code-reviewer`). The `'unknown'` bucket catches Task dispatches
 *    whose `input.subagent_type` is missing or non-string.
 *  - `wallClockMs` stored here is the LAST value the manager computed;
 *    `getStats()` recomputes it against `Date.now()` before returning
 *    the snapshot so a slow flush never serves a stale wall-clock.
 */

/**
 * Per-tool aggregate. `count` is bumped on every `tool_call` regardless
 * of whether the tool resolved; `totalDurationMs` is only incremented
 * when both a `tool_call` and its matching `tool_result` carry usable
 * timestamps (so an in-flight tool contributes to `count` but not yet
 * to duration).
 */
export interface ToolCallStat {
  count: number;
  totalDurationMs: number;
}

/**
 * Per-file aggregate. `reads` is bumped on Read / Glob / Grep; `edits`
 * on Edit / Write / NotebookEdit. `lastTouchedAt` is the ISO timestamp
 * of the most recent observed tool_call for this path.
 */
export interface FileTouchStat {
  reads: number;
  edits: number;
  lastTouchedAt: string;
}

/**
 * Per-subagent ledger built from `Task` tool dispatches + their
 * matching results (R7). Every field except `dispatches` is best-effort
 * — the SDK only sometimes populates `usage` / `total_cost_usd` /
 * `duration_ms` on a Task result, so values may remain 0.
 */
export interface SubagentStat {
  dispatches: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationMs: number;
}

/**
 * Snapshot returned by `sessionManager.getStats(featureId)` and
 * serialised to `<featureId>.stats.json` on the throttled flush.
 *
 * All numeric fields are plain numbers (not bignum); the dashboard
 * deals in human-readable orders of magnitude and the agent SDK
 * itself returns plain numbers.
 */
export interface SessionStats {
  /** Aggregate USD cost across every `usage` event (top-level + sub). */
  costUsd: number;
  /** Top-level input-token count (excludes nested subagent usage). */
  inputTokens: number;
  /** Top-level output-token count. */
  outputTokens: number;
  /** Top-level cache-creation input tokens. */
  cacheCreationTokens: number;
  /** Top-level cache-read input tokens. */
  cacheReadTokens: number;
  /** Number of assistant turns observed in this session. */
  turns: number;
  /** Per-tool counters keyed by toolName (e.g. `Bash`, `Edit`). */
  toolCalls: Record<string, ToolCallStat>;
  /** Per-path touch counters keyed by absolute or relative file path. */
  filesTouched: Record<string, FileTouchStat>;
  /** Per-subagent ledger keyed by `subagent_type`. */
  subagents: Record<string, SubagentStat>;
  /** ISO timestamp captured at `start()` time; never overwritten. */
  startedAt: string;
  /**
   * Last-computed wall-clock in milliseconds. `getStats()` recomputes
   * this against `Date.now() - new Date(startedAt).getTime()` before
   * returning the snapshot so the value is always live for the caller.
   */
  wallClockMs: number;
}

/**
 * Build an empty `SessionStats` rooted at `startedAt`. The manager
 * calls this once per session; subsequent events mutate the returned
 * object in place.
 */
export function createSessionStats(startedAt: string): SessionStats {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    toolCalls: {},
    filesTouched: {},
    subagents: {},
    startedAt,
    wallClockMs: 0,
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Tiny per-field accessors used by the session manager. Exported so they */
/* can be unit-tested in isolation if a future task adds a stats spec.    */
/* ────────────────────────────────────────────────────────────────────── */

/** Ensure `stats.toolCalls[name]` exists and return it. */
export function ensureToolCallStat(
  stats: SessionStats,
  toolName: string,
): ToolCallStat {
  let entry = stats.toolCalls[toolName];
  if (!entry) {
    entry = { count: 0, totalDurationMs: 0 };
    stats.toolCalls[toolName] = entry;
  }
  return entry;
}

/** Ensure `stats.filesTouched[path]` exists and return it. */
export function ensureFileTouchStat(
  stats: SessionStats,
  filePath: string,
  ts: string,
): FileTouchStat {
  let entry = stats.filesTouched[filePath];
  if (!entry) {
    entry = { reads: 0, edits: 0, lastTouchedAt: ts };
    stats.filesTouched[filePath] = entry;
  }
  return entry;
}

/** Ensure `stats.subagents[subagentType]` exists and return it. */
export function ensureSubagentStat(
  stats: SessionStats,
  subagentType: string,
): SubagentStat {
  let entry = stats.subagents[subagentType];
  if (!entry) {
    entry = {
      dispatches: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      durationMs: 0,
    };
    stats.subagents[subagentType] = entry;
  }
  return entry;
}

/**
 * Tool names whose inputs carry a single `file_path` field that we
 * attribute to either reads or edits. Stored as exported sets so the
 * session-manager branch logic stays declarative and so a future
 * frontend / tester can re-use the classification.
 */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
]);

export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
]);

/**
 * Tools whose path-bearing field is the search pattern itself
 * (`pattern` for Glob / Grep). Counted as reads.
 */
export const PATTERN_TOOLS: ReadonlySet<string> = new Set([
  'Glob',
  'Grep',
]);

/**
 * Extract the path-or-pattern attributable to a tool call, or `null`
 * if the input shape doesn't carry one we recognise.
 *
 * Spec mapping:
 *  - Read / Edit / Write / NotebookEdit → `input.file_path`
 *  - Glob / Grep                        → `input.pattern`
 */
export function extractTouchPath(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (READ_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName)) {
    const fp = (input as { file_path?: unknown }).file_path;
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  }
  if (PATTERN_TOOLS.has(toolName)) {
    const pat = (input as { pattern?: unknown }).pattern;
    return typeof pat === 'string' && pat.length > 0 ? pat : null;
  }
  return null;
}

/** Classify a path-bearing tool as a read vs an edit. */
export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}
