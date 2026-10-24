// Definition-of-Done gate: required-gate set + pass rule
// (skills/orchestrator/references/dod-gate.md, spec R12).

import fs from 'node:fs';
import path from 'node:path';
import { hasOpenDecisions } from './decisions.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { isOwnerTask, parsePlan, tasksSource } from './plan.mjs';
import { isDeferred, readPolish } from './polish.mjs';
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
  if (track === 'lite' || track === 'polish') {
    const areas = Array.isArray(fj.areas) ? fj.areas.map((a) => a?.name).filter(Boolean) : [];
    const area = areas.length ? areas.map((n) => `implement.area=${n}`) : ['implement.area=<none>'];
    gates = track === 'polish' ? area : ['spec', ...area];
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

/**
 * `spec analyze` counts for a feature folder. Read-only; a malformed input
 * (UsageError) is reported as `malformed` and counts as failing.
 * @returns {{errors: number, warnings: number, malformed: boolean}}
 */
export function specAnalyzeCounts(dir, specText) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; } };
  try {
    const r = analyzeSpec({ specText, tasksText: tasksSource(dir)?.text ?? null, reportText: read('test-report.md') });
    return { errors: r.errors.length, warnings: r.warnings.length, malformed: false };
  } catch (err) {
    if (err instanceof UsageError) return { errors: 0, warnings: 0, malformed: true };
    throw err;
  }
}

/**
 * Polish `items` precondition: MISSING (no polish.md / 0 items), OPEN (an item
 * neither IMPL-DONE/DONE nor deferred with a reason), else OK.
 * @param {string} dir
 */
export function polishItemsStatus(dir) {
  const p = readPolish(dir);
  if (!p || p.items.length === 0) return 'MISSING';
  const open = p.items.some((it) => !(it.status === 'IMPL-DONE' || it.status === 'DONE' || isDeferred(it)));
  return open ? 'OPEN' : 'OK';
}

/**
 * Full gate report: preconditions dod evaluates (tasks, decisions,
 * spec-analyze) followed by every required gate. `needs` is the non-passing
 * subset in the same order, so `needs[0]` is the gate dod fails on.
 * @param {string} dir
 * @returns {{passed: boolean, required: string[], checks: {gate: string, status: string, pass: boolean}[],
 *   needs: {gate: string, status: string}[], failed?: {gate: string, status: string}}}
 */
export function dodReport(dir) {
  const fj = readFeatureJson(dir);
  const full = !isQuickFlow(fj) && (fj.track || 'full') === 'full';
  const tasks = full ? taskNumbers(tasksSource(dir)?.text ?? null) : [];
  const parsed = full && fj.owner_blocking === true ? parsePlan(tasksSource(dir)?.text ?? '') : [];
  const owners = parsed.filter(isOwnerTask);
  const ownerStatus = new Map(owners.map((t) => [`owner.task=${t.n}`, t.status]));
  const required = requiredGates(fj, tasks, owners.map((t) => t.n));
  const checks = [];
  const add = (gate, status, pass) => checks.push({ gate, status, pass });
  if (full && fj.separate_plan === false) {
    add('tasks', tasks.length === 0 ? 'MISSING' : 'OK', tasks.length > 0);
  }
  if (fj.flow === 'feature' && fj.track === 'polish') {
    const st = polishItemsStatus(dir);
    add('items', st, st === 'OK');
  }
  if (fj.flow === 'feature' && !['quick', 'polish'].includes(fj.track || 'full')) {
    let spec = null;
    try { spec = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    if (spec !== null) {
      const open = hasOpenDecisions(spec);
      add('decisions', open ? 'OPEN' : 'OK', !open);
      const c = specAnalyzeCounts(dir, spec);
      const fails = c.errors > 0 || c.malformed;
      add('spec-analyze', fails ? 'ERRORS' : 'OK', !fails);
    }
  }
  for (const gate of required) {
    // owner.task gates come from the tasks source status, never history.
    const status = ownerStatus.has(gate) ? ownerStatus.get(gate) : lastStatus(fj.history, gate);
    add(gate, status, PASS_SET.has(status));
  }
  const needs = checks.filter((c) => !c.pass).map(({ gate, status }) => ({ gate, status }));
  return { passed: needs.length === 0, required, checks, needs, ...(needs.length ? { failed: needs[0] } : {}) };
}

/**
 * Evaluate the gate for a feature folder.
 * @param {string} dir
 * @returns {{passed: boolean, required: string[], failed?: {gate: string, status: string}}}
 */
export function evaluateDod(dir) {
  const { passed, required, failed } = dodReport(dir);
  return passed ? { passed, required } : { passed, required, failed };
}
