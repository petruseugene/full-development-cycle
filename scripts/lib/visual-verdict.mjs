// `dev-cycle visual verdict` — the numeric verdict and the test-report.md
// section (spec R10, R18, AC12, AC13).
//
//   computeVerdict({manifest, catalog, teardown, root, visual?, platform?})
//     → {status, reasons[], screens[], run_time_s, budget_s, passed, total}
//   renderSections(verdict, {ts, notes}) → markdown (`## Visual tests — …`
//     plus its `## AC coverage — visual` sibling)
//   mergeReport(existingText|null, verdict, {ts}) → new test-report.md text
//
// The verdict is pure data: the agent cannot soften it. Only the sections the
// CLI wrote itself are replaced; every other section stays byte-identical.

import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWrite, output, parseCommandArgs, readText, resolveFeatureDir, resolveProjectRoot,
} from './core.mjs';
import {
  DEFAULT_SCREEN_TIMEOUT_S, buildCatalog, loadVisualConfig, readManifest, referenceProblems,
  resolveInside, updateManifest, verificationDir,
} from './visual-core.mjs';

const USAGE = 'visual verdict [--json] [--feature <dir>]';
const VISUAL_HEAD_RE = /^## Visual tests\b/;
const AC_HEAD_RE = /^## AC coverage\s+[—–-]+\s+visual\b/;
const NOTES_RE = /^\*\*Notes:\*\*[\s\S]*$/m;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const times = (...vals) => vals.map((v) => Date.parse(v)).filter((n) => Number.isFinite(n));
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function fmtNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(2);
  if (v === null || v === undefined) return 'unmeasured';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** One-line description of a check: `scale friend/hero 0.85 vs 1.00 ±10% (vision)`. */
export function describeCheck(c) {
  const parts = [`${c.type ?? 'check'} ${c.subject ?? ''}`.trim(), `${fmtNum(c.measured)} vs ${fmtNum(c.expected)}`];
  if (c.tolerance !== undefined && c.tolerance !== null) parts.push(`±${c.tolerance}%`);
  if (c.source) parts.push(`(${c.source})`);
  return parts.join(' ');
}

function referenceMissing(root, ref) {
  if (typeof ref !== 'string' || ref === '' || ref === 'none') return null;
  if (referenceProblems(ref).length > 0) return 'unsafe path';
  try {
    return fs.existsSync(resolveInside(root, ref)) ? null : 'not found';
  } catch {
    return 'outside project';
  }
}

function lastActivity(manifest) {
  const stamps = [manifest.last_activity];
  for (const s of Object.values(manifest.screens ?? {})) stamps.push(s?.started_at, s?.ended_at, s?.updated_at);
  const t = times(...stamps);
  return t.length ? Math.max(...t) : null;
}

/** Known viewport width of a web screen: `breakpoint`, or a `web-375` / `375` target. */
function breakpointOf(entry) {
  if (!entry) return null;
  const raw = entry.breakpoint ?? /^(?:web[-@ ]?)?(\d{2,5})(?:px)?$/i.exec(String(entry.target ?? ''))?.[1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Compute the verdict (R10). Pure apart from `fs.existsSync` on references.
 * @param {{manifest: Record<string, any>, catalog?: Array<Record<string, any>>,
 *   teardown?: Record<string, any>|null, root: string,
 *   visual?: Record<string, any>|null, platform?: string}} input
 */
export function computeVerdict({ manifest, catalog = [], teardown = null, root, visual = null, platform = 'web' }) {
  const m = isObject(manifest) ? manifest : {};
  const recorded = isObject(m.screens) ? m.screens : {};
  const selected = Array.isArray(m.plan?.selected) ? m.plan.selected : [];
  const planned = isObject(m.plan) && Array.isArray(m.plan.selected);
  const ids = [...new Set([...selected, ...Object.keys(recorded)])];
  const reasons = [];
  const screens = [];

  for (const id of ids) {
    const entry = isObject(recorded[id]) ? recorded[id] : null;
    const cat = catalog.find((s) => s.id === id) ?? null;
    const own = [];
    const details = [];
    const hasChecks = Boolean(entry) && Array.isArray(entry.checks) && entry.checks.length > 0;
    const checked = entry && (entry.screenshot || hasChecks);
    // Without a plan (the agent skipped `visual plan`), a catalog screen that
    // has profile checks and was run/marked but never checked is missing too.
    const unplannedUnchecked = !planned && entry && !hasChecks
      && Array.isArray(cat?.checks) && cat.checks.length > 0;
    if ((!checked && selected.includes(id)) || unplannedUnchecked) {
      own.push(`missing: ${id}`);
      details.push('missing (never checked)');
    }
    const ref = cat ? cat.reference : entry?.reference;
    const refProblem = referenceMissing(root, ref);
    if (refProblem) {
      own.push(`no-reference: ${id} (${ref})`);
      details.push(`no-reference ${ref} (${refProblem})`);
    }
    if (entry && (entry.result === 'timeout' || entry.timed_out === true)) {
      own.push(`timeout: ${id}`);
      details.push(`timeout (${fmtNum(entry.duration_s)}s over the limit)`);
    }
    for (const c of Array.isArray(entry?.checks) ? entry.checks : []) {
      if (c?.result === 'pass') continue;
      const kind = c?.result === 'fail' ? 'fail' : 'unmeasured';
      own.push(`${kind}: ${id} ${c?.type ?? ''} ${c?.subject ?? ''}`.trim());
      details.push(`${kind === 'unmeasured' ? 'unmeasured ' : ''}${describeCheck(c ?? {})}`);
    }
    for (const f of Array.isArray(entry?.failures) ? entry.failures : []) {
      own.push(`--fail: ${id} — ${f}`);
      details.push(`--fail ${f}`);
    }
    const limit = entry?.timeout_s ?? cat?.timeout_s ?? visual?.screen_timeout_s ?? DEFAULT_SCREEN_TIMEOUT_S;
    reasons.push(...own);
    screens.push({
      id,
      target: entry?.target ?? cat?.target ?? visual?.device ?? platform ?? 'web',
      ok: own.length === 0,
      duration_s: typeof entry?.duration_s === 'number' ? entry.duration_s : null,
      limit_s: limit,
      adhoc: Boolean(entry?.adhoc),
      breakpoint: breakpointOf(entry),
      acs: Array.isArray(entry?.acs) ? entry.acs : (Array.isArray(cat?.acs) ? cat.acs : []),
      reasons: own,
      details,
    });
  }

  if (m.build?.status === 'failed') reasons.push('build failed');

  const run_time_s = round1(screens.reduce((sum, s) => sum + (s.duration_s ?? 0), 0));
  const budget_s = m.plan?.budget_s > 0 ? m.plan.budget_s : screens.reduce((sum, s) => sum + s.limit_s, 0);
  if (run_time_s > budget_s) reasons.push(`over budget: ${run_time_s}s > ${budget_s}s`);

  if (Object.keys(recorded).length === 0) reasons.push('no-screens');

  const last = lastActivity(m);
  const markerTs = isObject(teardown) ? times(teardown.ts)[0] : undefined;
  if (markerTs === undefined || (last !== null && markerTs < last)) {
    reasons.push('no-teardown');
  } else {
    const bad = (Array.isArray(teardown.steps) ? teardown.steps : []).filter((s) => !s || s.ok !== true);
    if (bad.length > 0) reasons.push(`teardown step failed: ${bad.map((s) => s?.name ?? '?').join(', ')}`);
  }

  const passed = screens.filter((s) => s.ok).length;
  return {
    status: reasons.length === 0 ? 'PASSED' : 'FAILED',
    reasons, screens, run_time_s, budget_s, passed, total: screens.length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GLOBAL_RE = /^(build failed|over budget|no-screens|no-teardown|teardown step failed)/;

/** The `## Visual tests — …` section and its `## AC coverage — visual` sibling. */
export function renderSections(v, { ts, notes = '' }) {
  const lines = [
    `## Visual tests — ${ts} — ${v.status}`,
    `visual-diff: ${v.passed}/${v.total}`,
    `Run time: ${v.run_time_s}s / budget ${v.budget_s}s (limit per screen shown below)`,
  ];
  const globals = v.reasons.filter((r) => GLOBAL_RE.test(r));
  if (globals.length) lines.push(`Reasons: ${globals.join('; ')}`);
  lines.push('');
  for (const s of v.screens) {
    const where = s.breakpoint !== null && (s.target === 'web' || s.target === undefined) ? s.breakpoint : s.target;
    const head = `${s.id} @ ${where}`;
    lines.push(s.ok
      ? `- [pass] ${head} — ${s.duration_s ?? '–'}s/${s.limit_s}s`
      : `- [fail] ${head} — ${s.details.join('; ')} — ${s.duration_s ?? '–'}s/${s.limit_s}s`);
  }
  if (notes) lines.push('', notes.trimEnd());
  let out = lines.join('\n') + '\n';
  const withAcs = v.screens.filter((s) => s.acs.length > 0);
  const noAc = v.screens.filter((s) => s.adhoc && s.acs.length === 0);
  if (withAcs.length || noAc.length) {
    out += '\n## AC coverage — visual\n';
    for (const s of withAcs) {
      out += `- [${s.ok ? 'pass' : 'fail'}] ${s.acs.join(', ')} — verification/manifest.json › "${s.id}"\n`;
    }
    if (noAc.length) out += `- ad-hoc, no AC: ${noAc.map((s) => s.id).join(', ')}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// test-report.md merge
// ---------------------------------------------------------------------------

/** Split into sections at `## ` headings (outside code fences). */
function splitSections(body) {
  const sections = [];
  let cur = { head: null, text: '' };
  let fence = false;
  for (const line of body.split(/(?<=\n)/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) {
      sections.push(cur);
      cur = { head: line.replace(/\r?\n$/, ''), text: '' };
    }
    cur.text += line;
  }
  sections.push(cur);
  return sections;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function setFmKey(fm, key, value) {
  const re = new RegExp(`^${key}\\s*:.*$`, 'm');
  return re.test(fm) ? fm.replace(re, `${key}: ${value}`) : `${fm}${fm === '' || fm.endsWith('\n') ? '' : '\n'}${key}: ${value}`;
}

/**
 * Apply the verdict to a test-report.md text (null = absent file).
 * Replaces earlier CLI-written visual sections, keeps others byte-identical,
 * and merges `status` / `failures_count` (R10).
 * @param {string|null} existing
 * @param {ReturnType<typeof computeVerdict>} v
 * @param {{ts: string}} opts
 */
export function mergeReport(existing, v, { ts }) {
  let fm = '';
  let body = '';
  let hasFm = false;
  if (existing) {
    const m = FM_RE.exec(existing);
    if (m) { hasFm = true; fm = m[1]; body = existing.slice(m[0].length); } else body = existing;
  }
  const sections = splitSections(body);
  let insertAt = -1;
  let prevFailed = 0;
  let prevStatus = null;
  const noteParts = [];
  const kept = [];
  for (const s of sections) {
    const isVisual = s.head !== null && VISUAL_HEAD_RE.test(s.head);
    const isAc = s.head !== null && AC_HEAD_RE.test(s.head);
    if (!isVisual && !isAc) { kept.push(s); continue; }
    if (insertAt < 0) insertAt = kept.length;
    if (isVisual) {
      prevFailed += (s.text.match(/^- \[fail\]/gm) ?? []).length;
      prevStatus ??= /—\s*(PASSED|FAILED)\s*$/.exec(s.head)?.[1] ?? null;
    }
    const n = NOTES_RE.exec(s.text);
    if (n) noteParts.push(n[0].trimEnd());
  }
  const block = { head: null, text: renderSections(v, { ts, notes: [...new Set(noteParts)].join('\n\n') }) };
  if (insertAt < 0) insertAt = kept.length;
  kept.splice(insertAt, 0, block);

  // Join, giving the new block a blank-line gap on each side.
  let text = '';
  kept.forEach((s, i) => {
    let t = s.text;
    if (s === block) {
      if (text !== '' && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n';
      if (i < kept.length - 1) t = `${t}\n`;
    }
    text += t;
  });

  const existingCount = Number.parseInt(/^failures_count\s*:\s*(\d+)/m.exec(fm)?.[1] ?? '0', 10);
  const existingStatus = /^status\s*:\s*(\w+)/m.exec(fm)?.[1] ?? null;
  const others = Math.max(0, existingCount - prevFailed);
  const failedScreens = v.screens.filter((s) => !s.ok).length;
  let status;
  if (v.status === 'FAILED') status = 'FAILED';
  else if (existingStatus === 'FAILED' && (others > 0 || prevStatus !== 'FAILED')) status = 'FAILED';
  else status = 'PASSED';
  fm = setFmKey(fm, 'status', status);
  fm = setFmKey(fm, 'failures_count', failedScreens + others);
  const front = `---\n${fm}\n---\n`;
  const sep = hasFm || text.startsWith('\n') ? '' : '\n';
  return `${front}${sep}${text}`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function readTeardown(vdir) {
  const text = readText(path.join(vdir, 'teardown.json'), { optional: true });
  if (text === null) return null;
  try {
    const obj = JSON.parse(text);
    return isObject(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  return runWith(argv, ctx);
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{now?: () => Date}} [deps]
 * @returns {Promise<number>} 1 on FAILED, 0 on PASSED
 */
export async function runWith(argv, ctx, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const { values } = parseCommandArgs(argv, { usage: USAGE });
  const featureDir = resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  const { visual, platform } = loadVisualConfig(ctx, featureDir);
  const specText = readText(path.join(featureDir, 'spec.md'), { optional: true });
  const catalog = buildCatalog(visual, specText);
  const manifest = readManifest(featureDir);
  const teardown = readTeardown(verificationDir(featureDir));
  const v = computeVerdict({ manifest, catalog, teardown, root, visual, platform });
  const ts = now().toISOString();

  const file = path.join(featureDir, 'test-report.md');
  const before = readText(file, { optional: true });
  atomicWrite(file, mergeReport(before, v, { ts }), { expected: before });
  updateManifest(featureDir, (mf) => {
    mf.verdict = {
      status: v.status, ts, run_time_s: v.run_time_s, budget_s: v.budget_s,
      passed: v.passed, total: v.total, reasons: v.reasons,
    };
  });

  const text = [`visual verdict: ${v.status} (${v.passed}/${v.total} screens, ${v.run_time_s}s / budget ${v.budget_s}s)`];
  for (const r of v.reasons) text.push(`  - ${r}`);
  output(ctx, values, {
    text,
    data: { status: v.status, reasons: v.reasons, passed: v.passed, total: v.total, run_time_s: v.run_time_s, budget_s: v.budget_s, screens: v.screens },
  });
  return v.status === 'FAILED' ? 1 : 0;
}
