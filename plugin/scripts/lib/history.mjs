// history entries: phase grammar (spec R9), duration/token parsing, append.

import { UsageError } from './core.mjs';
import { updateFeatureJson } from './feature-json.mjs';

// Closed phase vocabulary (spec R9). One entry per registry dispatch
// (playbook §10) across the feature, bugfix and hotfix flows:
//   discovery            dev-cycle:discovery
//   architecture         dev-cycle:architector
//   spec | wireframe | plan   spec-writer | wireframer | plan-writer
//   implement            quick-track / bugfix / hotfix implementer
//   implement.task=<n>   full-track implementer (also fix cycles)
//   implement.area=<name> lite-track implementer
//   migrate              migration step (backend-dev; formerly db-migrator) (bugfix/hotfix/quick/lite)
//   migrate.task=<n>     migration step for plan task n
//   static-check | review | auto-test | visual-test | a11y | deps-audit | security
//                        end gates; matched by phase, whatever the subagent
//                        (a11y = visual-tester, deps-audit = security-reviewer;
//                        old a11y-auditor / dependency-auditor entries still count)
//   release              ship --release (formerly release-manager)
//   git                  cli-fallback: branch, commit, push, PR, merge
//   cherry-pick          cli-fallback: hotfix cherry-pick forward to main
//   gate.<name>          profile extra gate (name: [a-z0-9][a-z0-9-]*)
//   interview | conflict orchestrator bookkeeping (excluded from totals)
//   worktree             worktree isolation collect/audit bookkeeping (task and group
//                        entries; excluded from totals)
//   orchestrator         orchestrator's own measured tokens (excluded from by_*)
//   profile              `profile snapshot` refresh (cli bookkeeping, executor cli: not in totals)
export const PHASE_VOCABULARY = Object.freeze([
  'discovery', 'architecture', 'spec', 'wireframe', 'plan',
  'implement', 'implement.task=<n>', 'implement.area=<name>',
  'migrate', 'migrate.task=<n>', 'owner.task=<n>',
  'static-check', 'review', 'auto-test', 'visual-test', 'a11y', 'deps-audit', 'security',
  'release', 'git', 'cherry-pick', 'gate.<name>', 'interview', 'conflict', 'worktree', 'orchestrator', 'profile',
]);

const SIMPLE_PHASES = new Set(PHASE_VOCABULARY.filter((p) => !p.includes('<')));

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** True when `phase` is in the closed phase grammar (R9). */
export function isValidPhase(phase) {
  if (typeof phase !== 'string') return false;
  if (SIMPLE_PHASES.has(phase)) return true;
  if (/^(implement|migrate|owner)\.task=\d+$/.test(phase)) return true;
  if (/^implement\.area=[a-z0-9][a-z0-9-]*$/.test(phase)) return true;
  const m = /^gate\.(.+)$/.exec(phase);
  return Boolean(m && NAME_RE.test(m[1]));
}

/** `52`, `52s`, `2m 14s` (also `2m`, `1h 2m 3s`) → seconds. Throws UsageError. */
export function parseDuration(text) {
  const s = String(text ?? '').trim();
  if (/^\d+(\.\d+)?s?$/.test(s)) return Math.round(parseFloat(s) * 1000) / 1000;
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (!m || s === '' || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    throw new UsageError(`invalid --duration '${text}' (use 52, 52s or '2m 14s')`);
  }
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}

/** `3.2`, `3.2k`, `~3.2k` → 3.2. Throws UsageError. */
export function parseTokens(text) {
  const s = String(text ?? '').trim();
  const m = /^~?(\d+(?:\.\d+)?)k?$/i.exec(s);
  if (!m) throw new UsageError(`invalid --tokens '${text}' (use 3.2, 3.2k or ~3.2k)`);
  return parseFloat(m[1]);
}

/**
 * Append one entry to feature.json history (totals recomputed by
 * updateFeatureJson). Throws UsageError on an invalid phase, before writing.
 * @param {string} dir feature folder
 * @param {{ts?: string, phase: string, subagent: string, status: string, model?: string,
 *   duration_s?: number, tokens_k?: number, summary?: string, concerns?: string}} entry
 * @returns {object} the appended entry
 */
export function appendHistory(dir, entry) {
  if (!isValidPhase(entry.phase)) {
    throw new UsageError(`invalid --phase '${entry.phase}'`);
  }
  const full = { ts: entry.ts ?? new Date().toISOString(), phase: entry.phase, subagent: entry.subagent, status: entry.status, model: entry.model ?? 'inherit' };
  for (const k of ['duration_s', 'tokens_k', 'summary', 'concerns', 'executor', 'agent_id', 'tokens', 'estimated', 'model_id', 'usd_est', 'usd_unpriced', 'started_at', 'ended_at',
    'resolved_by', 'task', 'touches_expanded', 'files', 'conflicts', 'tasks', 'stray', 'mode']) {
    if (entry[k] !== undefined) full[k] = entry[k];
  }
  updateFeatureJson(dir, (fj) => {
    if (fj.history !== undefined && !Array.isArray(fj.history)) {
      throw new UsageError('feature.json history must be an array');
    }
    fj.history = [...(fj.history ?? []), full];
  });
  return full;
}
