// Report model assembly for `dev-cycle report` (spec R20, R25; AC21, AC26).
// Reads feature folders (read-only) and combines the pure timeline, cost and
// AC-map models. The only side effect is the optional `gh pr view` call, made
// through an injectable runner (argv, no shell, 10 s timeout).
//
//   listFeatureFolders(featuresRoot)            -> string[] (sorted folder names with feature.json)
//   loadFeature(dir, {projectRoot})             -> feature model | {folder, unreadable}
//   waitingOwner(features, {now})               -> waiting_owner[]
//   prState(branch, {gh, noNetwork, timeout_s}) -> {state, url?, reason?}
//   unconfirmedMerges(features, {profile, gh, noNetwork, timeout_s}) -> Promise<unconfirmed_merges[]>
//   buildReportModel({featuresRoot, folders?, projectRoot?, profile?, now, noNetwork?, gh?, timeout_s?})
//     -> Promise<{generated_at, features[], trend[], tracks[], waiting_owner[], unconfirmed_merges[]}>

import fs from 'node:fs';
import path from 'node:path';
import { ghRun } from './git-exec.mjs';
import { isOwnerTask, parsePlan, tasksSource } from './plan.mjs';
import { buildTimeline } from './report-timeline.mjs';
import { buildCost, buildTracks, buildTrend } from './report-cost.mjs';
import { buildAcMap } from './report-ac.mjs';

export const GH_PR_TIMEOUT_S = 10;
export const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const POST_MERGE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const OWNER_PHASE_RE = /^owner\.task=(\d+)$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const parseMs = (v) => {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
};
const iso = (ms) => new Date(ms).toISOString();

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Sorted names of sub-folders of `root` that contain a feature.json. */
export function listFeatureFolders(root) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  return names.filter((n) => fs.existsSync(path.join(root, n, 'feature.json'))).sort(cmp);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Spec title: the first `# ` heading, else null. */
function specTitle(specText) {
  const m = /^#\s+(.+?)\s*$/m.exec(specText ?? '');
  return m ? m[1] : null;
}

function posixRel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

/** Gallery block from `verification/manifest.json` + `verification/index.html` (never throws). */
function loadGallery(dir, projectRoot) {
  const index = path.join(dir, 'verification', 'index.html');
  const gallery = {
    path: projectRoot ? posixRel(projectRoot, index) : index,
    exists: isFile(index),
    verdict: null,
    run_time_s: null,
    budget_s: null,
  };
  const text = readOptional(path.join(dir, 'verification', 'manifest.json'));
  if (text === null) return gallery;
  let m;
  try { m = JSON.parse(text); } catch { gallery.manifest_error = 'invalid JSON'; return gallery; }
  if (!isObj(m)) return gallery;
  const v = isObj(m.verdict) ? m.verdict : {};
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  gallery.verdict = str(v.status);
  gallery.run_time_s = num(v.run_time_s);
  gallery.budget_s = num(v.budget_s) ?? num(isObj(m.plan) ? m.plan.budget_s : undefined);
  return gallery;
}

/** Names `<name>` of `post-merge/<name>.log` files. */
function postMergeLogs(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'post-merge'))
      .filter((f) => f.endsWith('.log'))
      .map((f) => f.slice(0, -4))
      .sort(cmp);
  } catch { return []; }
}

/**
 * Load one feature folder. A missing/malformed feature.json yields
 * `{folder, unreadable: '<reason>'}`; any other file may be absent (legacy).
 * @param {string} dir
 * @param {{projectRoot?: string}} [opts]
 */
export function loadFeature(dir, { projectRoot } = {}) {
  const folder = path.basename(dir);
  const raw = readOptional(path.join(dir, 'feature.json'));
  if (raw === null) return { folder, unreadable: 'feature.json not readable' };
  let fj;
  try { fj = JSON.parse(raw); } catch (err) { return { folder, unreadable: `invalid JSON in feature.json: ${err.message}` }; }
  if (!isObj(fj)) return { folder, unreadable: 'feature.json is not an object' };
  const history = Array.isArray(fj.history) ? fj.history.filter(isObj) : [];

  let src = null;
  try { src = tasksSource(dir); } catch { src = null; }
  let tasks = [];
  if (src) { try { tasks = parsePlan(src.text); } catch { tasks = []; } }
  const specText = readOptional(path.join(dir, 'spec.md')) ?? '';
  const reportText = readOptional(path.join(dir, 'test-report.md')) ?? '';

  let tl;
  try { tl = buildTimeline(history, src ? { tasks } : {}); } catch { tl = buildTimeline(history); }
  const { ac_map, counts } = buildAcMap({ specText, planText: src ? src.text : '', reportText });

  const feature = {
    folder,
    slug: str(fj.feature_slug),
    title: specTitle(specText) ?? str(fj.feature_slug) ?? folder,
    created: str(fj.created),
    flow: str(fj.flow),
    track: str(fj.track),
    current_phase: str(fj.current_phase),
    started_at: str(fj.started_at),
    branch: str(fj.branch),
    history,
    tasks: tasks.map((t) => ({ n: t.n, title: t.title, tag: t.tag, status: t.status, owner: isOwnerTask(t) })),
    timeline: tl.timeline,
    lanes: tl.lanes,
    fix_cycles: tl.fix_cycles,
    waits: tl.waits,
    cost: buildCost(history),
    ac_map,
    ac_counts: counts,
    has_test_report: reportText !== '',
    gallery: loadGallery(dir, projectRoot),
    post_merge_logs: postMergeLogs(dir),
  };
  if (tl.plan_groups) feature.plan_groups = tl.plan_groups;
  return feature;
}

function latestPlanDoneMs(history, beforeMs = Infinity) {
  let best;
  for (const e of history) {
    if (e.phase !== 'plan' || !String(e.status ?? '').startsWith('DONE')) continue;
    const ms = parseMs(e.ts);
    if (ms === undefined || ms > beforeMs) continue;
    if (best === undefined || ms > best) best = ms;
  }
  return best;
}

/**
 * Owner tasks: open ones (not DONE, `since` = latest plan DONE ts, else
 * started_at) and completed waits from `owner.task=<n>` history entries.
 * @param {object[]} features readable feature models
 * @param {{now: string|Date|number}} opts
 */
export function waitingOwner(features, { now } = {}) {
  const nowMs = now === undefined ? undefined : new Date(now).getTime();
  const out = [];
  for (const f of features) {
    if (!f || f.unreadable) continue;
    const history = Array.isArray(f.history) ? f.history : [];
    const startMs = parseMs(f.started_at);
    const planMs = latestPlanDoneMs(history);
    const sinceMs = planMs ?? startMs;
    const titleOf = new Map((f.tasks ?? []).map((t) => [t.n, t.title]));
    for (const t of f.tasks ?? []) {
      if (!t.owner || t.status === 'DONE') continue;
      const row = {
        folder: f.folder, task: t.n, title: t.title, status: t.status, completed: false,
        since: sinceMs === undefined ? null : iso(sinceMs),
        since_source: planMs !== undefined ? 'plan' : startMs !== undefined ? 'started_at' : null,
        waiting_s: null,
      };
      if (sinceMs !== undefined && Number.isFinite(nowMs)) row.waiting_s = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
      out.push(row);
    }
    for (const e of history) {
      const m = OWNER_PHASE_RE.exec(e.phase ?? '');
      const endMs = parseMs(e.ts);
      if (!m || endMs === undefined) continue;
      const n = Number(m[1]);
      const p = latestPlanDoneMs(history, endMs);
      const s = p ?? (startMs !== undefined && startMs <= endMs ? startMs : undefined);
      out.push({
        folder: f.folder, task: n, title: titleOf.get(n) ?? null, status: str(e.status), completed: true,
        since: s === undefined ? null : iso(s),
        since_source: p !== undefined ? 'plan' : s !== undefined ? 'started_at' : null,
        end: iso(endMs),
        duration_s: s === undefined ? null : Math.round((endMs - s) / 1000),
      });
    }
  }
  return out;
}

function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** Default gh runner: argv only (no shell), via git-exec's ghRun. */
export function defaultGh(args, opts) {
  return ghRun(args, opts);
}

/**
 * PR state of one branch. Never throws.
 * @returns {Promise<{state: 'open'|'closed-unmerged'|'merged'|'unknown', url?: string, reason?: string}>}
 */
export async function prState(branch, { gh = defaultGh, noNetwork = false, timeout_s = GH_PR_TIMEOUT_S, cwd } = {}) {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch) || branch.startsWith('-')) return { state: 'unknown', reason: 'invalid branch name' };
  if (noNetwork) return { state: 'unknown', reason: 'no-network' };
  let r;
  try {
    // One value per argv element; the branch is validated above (lesson L2).
    r = await withTimeout(Promise.resolve(gh(['pr', 'view', branch, '--json', 'state,mergedAt,url'], { timeout_s, cwd })), timeout_s * 1000 + 1000);
  } catch (err) {
    return { state: 'unknown', reason: err?.reason === 'timeout' || /timeout|did not finish/i.test(String(err?.message)) ? 'timeout' : 'gh failed' };
  }
  if (!r || r.code !== 0) return { state: 'unknown', reason: `gh exit ${r?.code ?? 'null'}` };
  let j;
  try { j = JSON.parse(String(r.stdout ?? '')); } catch { return { state: 'unknown', reason: 'unparsable gh output' }; }
  if (!isObj(j)) return { state: 'unknown', reason: 'unparsable gh output' };
  const url = typeof j.url === 'string' ? j.url : undefined;
  const merged = str(j.mergedAt) !== null;
  const out = (state) => (url === undefined ? { state } : { state, url });
  if (j.state === 'MERGED' || merged) return out('merged');
  if (j.state === 'OPEN') return out('open');
  if (j.state === 'CLOSED') return out('closed-unmerged');
  return { state: 'unknown', reason: 'unexpected gh state' };
}

function confirmSteps(profile) {
  const list = isObj(profile) && Array.isArray(profile.post_merge) ? profile.post_merge : [];
  return list.filter((s) => isObj(s) && s.confirm === true && typeof s.name === 'string' && POST_MERGE_NAME_RE.test(s.name)).map((s) => s.name);
}

/**
 * (a) PRs not confirmed merged and (b) unconfirmed `confirm:true` post-merge
 * steps of merged/done features. Order: by folder, PR row first, then steps.
 */
export async function unconfirmedMerges(features, { profile, gh, noNetwork = false, timeout_s = GH_PR_TIMEOUT_S, cwd } = {}) {
  const steps = confirmSteps(profile);
  const readable = features.filter((f) => f && !f.unreadable);
  const states = await Promise.all(readable.map(async (f) => {
    const hasGit = (f.history ?? []).some((e) => e.phase === 'git');
    if (!hasGit || f.branch === null || f.branch === undefined) return null;
    return prState(f.branch, { gh, noNetwork, timeout_s, cwd });
  }));
  const out = [];
  readable.forEach((f, i) => {
    const pr = states[i];
    if (pr && pr.state !== 'merged') {
      const row = { folder: f.folder, kind: 'pr', branch: f.branch, state: pr.state };
      if (pr.url !== undefined) row.url = pr.url;
      if (pr.reason) row.reason = pr.reason;
      out.push(row);
    }
    const done = (pr && pr.state === 'merged') || f.current_phase === 'done';
    if (!done) return;
    const logs = new Set(f.post_merge_logs ?? []);
    for (const name of steps) {
      if (!logs.has(name)) out.push({ folder: f.folder, kind: 'post-merge', step: name, state: 'unconfirmed' });
    }
  });
  return out;
}

/**
 * Assemble the whole report model. Deterministic for fixed inputs: features
 * sorted by folder name, `now` injected.
 * @param {{featuresRoot: string, folders?: string[], projectRoot?: string, profile?: object,
 *   now: string|Date|number, noNetwork?: boolean, gh?: Function, timeout_s?: number}} opts
 */
export async function buildReportModel({
  featuresRoot, folders, projectRoot, profile = {}, now, noNetwork = false, gh, timeout_s = GH_PR_TIMEOUT_S,
} = {}) {
  const root = projectRoot ?? path.dirname(path.dirname(featuresRoot));
  const names = [...(folders ?? listFeatureFolders(featuresRoot))].sort(cmp);
  const features = names.map((n) => loadFeature(path.join(featuresRoot, n), { projectRoot: root }));
  const readable = features.filter((f) => !f.unreadable);
  const shaped = readable.map((f) => ({ folder: f.folder, created: f.created, flow: f.flow, track: f.track, history: f.history }));
  return {
    generated_at: new Date(now ?? Date.now()).toISOString(),
    features,
    trend: buildTrend(shaped),
    tracks: buildTracks(shaped),
    waiting_owner: waitingOwner(readable, { now }),
    unconfirmed_merges: await unconfirmedMerges(readable, { profile, gh, noNetwork, timeout_s, cwd: root }),
  };
}
