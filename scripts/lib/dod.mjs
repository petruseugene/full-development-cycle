// Definition-of-Done gate: required-gate set + pass rule
// (skills/orchestrator/references/dod-gate.md, spec R12).

import fs from 'node:fs';
import path from 'node:path';
import { hasOpenDecisions } from './decisions.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { isOwnerTask, parsePlan, tasksSource } from './plan.mjs';
import { analyzeSpec } from './spec-analyze.mjs';
import { UsageError } from './core.mjs';

export const PASS_SET = new Set(['DONE', 'APPROVED', 'PASSED']);

/**
 * Non-owner task numbers from the resolved tasks source (R38/R39/R42), in
 * plan order. Owner tasks are the owner's manual steps: never scheduled by
 * `groups` and never blocking dod.
 * @param {string|null} text plan.md / spec.md text
 * @returns {number[]}
 */
export function taskNumbers(text) {
  if (!text) return [];
  return parsePlan(text).filter((t) => !isOwnerTask(t)).map((t) => t.n);
}

/** True for flows that always use the quick gate set (R43). */
function isQuickFlow(fj) {
  return fj.flow === 'bugfix' || fj.flow === 'hotfix';
}

/**
 * Required gate keys, in evaluation order.
 *   - flow bugfix/hotfix: the quick set, whatever `track` says (R43);
 *   - track full: `spec`, then `plan` unless `separate_plan === false`, then
 *     one `implement.task=<n>` per task (R39);
 *   - track lite / quick: as documented in dod-gate.md.
 * @param {Record<string, any>} fj feature.json
 * @param {number[]} taskNumbers  non-owner tasks (used for track full)
 * @param {number[]} ownerNumbers owner tasks; gated as `owner.task=<n>` only in
 *   track full when `fj.owner_blocking === true`
 * @returns {string[]}
 */
export function requiredGates(fj, taskNumbers = [], ownerNumbers = []) {
  const track = isQuickFlow(fj) ? 'quick' : (fj.track || 'full');
  let gates;
  if (track === 'lite') {
    const areas = Array.isArray(fj.areas) ? fj.areas.map((a) => a?.name).filter(Boolean) : [];
    gates = ['spec', ...(areas.length ? areas.map((n) => `implement.area=${n}`) : ['implement.area=<none>'])];
  } else if (track === 'quick') {
    gates = ['implement'];
  } else {
    gates = ['spec', ...(fj.separate_plan === false ? [] : ['plan']), ...taskNumbers.map((n) => `implement.task=${n}`)];
    if (fj.owner_blocking === true) gates.push(...ownerNumbers.map((n) => `owner.task=${n}`));
  }
  gates.push('static-check', 'review');
  if (fj.auto_tests) gates.push('auto-test');
  if (fj.visual_tests) gates.push('visual-test');
  if (fj.a11y_audit) gates.push('a11y');
  if (fj.dependency_audit) gates.push('deps-audit');
  if (fj.security_review) gates.push('security');
  const extra = fj.profile && Array.isArray(fj.profile.extra_gates) ? fj.profile.extra_gates : [];
  for (const g of extra) if (g && typeof g.name === 'string') gates.push(`gate.${g.name}`);
  return gates;
}

/** Last history status for a gate key, or 'MISSING'. Matches by phase only, never by subagent (R23). */
export function lastStatus(history, gate) {
  let status = 'MISSING';
  for (const e of Array.isArray(history) ? history : []) {
    if (e && e.phase === gate && typeof e.status === 'string') status = e.status;
  }
  return status;
}

/** True when `spec analyze` would report errors. Read-only; a malformed input counts as an error. */
function specAnalyzeFails(dir, specText) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; } };
  try {
    const r = analyzeSpec({ specText, tasksText: tasksSource(dir)?.text ?? null, reportText: read('test-report.md') });
    return r.errors.length > 0;
  } catch (err) {
    if (err instanceof UsageError) return true;
    throw err;
  }
}

/**
 * Evaluate the gate for a feature folder.
 * @param {string} dir
 * @returns {{passed: boolean, required: string[], failed?: {gate: string, status: string}}}
 */
export function evaluateDod(dir) {
  const fj = readFeatureJson(dir);
  const full = !isQuickFlow(fj) && (fj.track || 'full') === 'full';
  const tasks = full ? taskNumbers(tasksSource(dir)?.text ?? null) : [];
  const parsed = full && fj.owner_blocking === true ? parsePlan(tasksSource(dir)?.text ?? '') : [];
  const owners = parsed.filter(isOwnerTask);
  const ownerStatus = new Map(owners.map((t) => [`owner.task=${t.n}`, t.status]));
  const required = requiredGates(fj, tasks, owners.map((t) => t.n));
  if (full && fj.separate_plan === false && tasks.length === 0) {
    return { passed: false, required, failed: { gate: 'tasks', status: 'MISSING' } };
  }
  if (fj.flow === 'feature' && (fj.track || 'full') !== 'quick') {
    let spec = null;
    try { spec = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    if (spec !== null && hasOpenDecisions(spec)) return { passed: false, required, failed: { gate: 'decisions', status: 'OPEN' } };
    if (spec !== null && specAnalyzeFails(dir, spec)) return { passed: false, required, failed: { gate: 'spec-analyze', status: 'ERRORS' } };
  }
  for (const gate of required) {
    // owner.task gates come from the tasks source status, never history.
    const status = ownerStatus.has(gate) ? ownerStatus.get(gate) : lastStatus(fj.history, gate);
    if (!PASS_SET.has(status)) return { passed: false, required, failed: { gate, status } };
  }
  return { passed: true, required };
}
