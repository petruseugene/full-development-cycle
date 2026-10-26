// Token-measurement coverage over feature.json history (spec R1).
// Only entries for dispatched subagents count: CLI and orchestrator
// bookkeeping never has an --agent-id to give.

const BOOKKEEPING_SUBAGENTS = new Set(['cli', 'gate', 'orchestrator', 'owner']);
const BOOKKEEPING_PHASES = new Set(['interview', 'conflict', 'worktree', 'orchestrator']);

/** True for a history entry that stands for a dispatched subagent report. */
export function isDispatchedEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (BOOKKEEPING_SUBAGENTS.has(entry.subagent)) return false;
  if (BOOKKEEPING_PHASES.has(entry.phase)) return false;
  if (entry.executor === 'cli') return false;
  return true;
}

/** `{measured, estimated}` over dispatched entries; `tokens` object = measured. */
export function tokenCoverage(history) {
  let measured = 0;
  let estimated = 0;
  if (!Array.isArray(history)) return { measured, estimated };
  for (const e of history) {
    if (!isDispatchedEntry(e)) continue;
    const t = e.tokens;
    if (t !== null && typeof t === 'object' && !Array.isArray(t)) measured++;
    else estimated++;
  }
  return { measured, estimated };
}

export function tokenCoverageLine(history) {
  const { measured, estimated } = tokenCoverage(history);
  return `tokens: ${measured} measured / ${estimated} estimated entries`;
}

export const NO_AGENT_ID_MESSAGE = 'no --agent-id: tokens are a self-estimate; pass --agent-id <id> for measured tokens';
