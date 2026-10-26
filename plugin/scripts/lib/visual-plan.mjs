// `dev-cycle visual plan [--all]` — select the catalog screens to verify and
// the time budget (spec R5, AC4). Writes `manifest.plan` (schema in
// visual-core.mjs); the other manifest keys are untouched.
//
// Selection source by track:
//   full        union of the task `Touches` in plan.md / spec.md
//   lite/polish feature.json.areas[].touches
//   quick/bugfix  `git diff --name-only <default-branch>...HEAD`
// A screen is selected when one of its `touches` globs overlaps a source
// glob (globsOverlap). Screens without `touches` need `--all`. Flow screens
// sharing one flow command are grouped under it (`plan.flows`).
// Budget: `visual.budget_s`, else the sum of screenLimit over the selection.

import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, output, parseCommandArgs, readText, resolveFeatureDir,
} from './core.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { globsOverlap } from './glob-overlap.mjs';
import { gitRun, execOpts } from './git-exec.mjs';
import { defaultBranch } from './git-branch.mjs';
import { parsePlan, tasksSource } from './plan.mjs';
import { buildCatalog, loadVisualConfig, screenLimit, updateManifest } from './visual-core.mjs';

const USAGE = 'visual plan [--all] [--json] [--feature <dir>]';

/** @param {string} dir feature folder @returns {string[]} union of task Touches */
function planTouches(dir) {
  const src = tasksSource(dir);
  if (!src) return [];
  return parsePlan(src.text).flatMap((t) => t.touches);
}

function areaTouches(fj) {
  return (Array.isArray(fj.areas) ? fj.areas : []).flatMap((a) => (Array.isArray(a?.touches) ? a.touches : []));
}

async function diffTouches(ctx, git) {
  const opts = { ...execOpts(ctx), ...(git.spawn ? { spawn: git.spawn } : {}) };
  const base = git.defaultBranch ? await git.defaultBranch(opts) : await defaultBranch(opts);
  const r = await git.gitRun(['diff', '--name-only', `${base}...HEAD`], opts);
  if (r.code !== 0) throw new UsageError(`visual plan: git diff ${base}...HEAD failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * The selection source: {source, globs}.
 * @returns {Promise<{source: 'plan'|'areas'|'diff', globs: string[]}>}
 */
async function selectionSource(ctx, featureDir, fj, git) {
  if (fj.track === 'full') {
    const globs = planTouches(featureDir);
    if (globs.length) return { source: 'plan', globs };
  } else if (fj.track === 'lite' || fj.track === 'polish') {
    const globs = areaTouches(fj);
    if (globs.length) return { source: 'areas', globs };
  }
  return { source: 'diff', globs: await diffTouches(ctx, git) };
}

/**
 * Pure selection.
 * @param {Array<Record<string, any>>} catalog
 * @param {string[]} globs
 * @param {boolean} all
 */
export function selectScreens(catalog, globs, all) {
  if (all) return catalog.slice();
  return catalog.filter((s) => Array.isArray(s.touches) && s.touches.length > 0
    && s.touches.some((t) => globs.some((g) => globsOverlap(t, g))));
}

/** Group flow screens by their flow command, in first-seen order. */
export function groupFlows(screens) {
  const flows = [];
  for (const s of screens) {
    if (typeof s.flow !== 'string' || s.flow === '') continue;
    let g = flows.find((f) => f.flow === s.flow);
    if (!g) { g = { flow: s.flow, screens: [] }; flows.push(g); }
    g.screens.push(s.id);
  }
  return flows;
}

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  return runWith(argv, ctx);
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{gitRun?: Function, now?: () => Date}} [deps]
 */
export async function runWith(argv, ctx, deps = {}) {
  const git = { gitRun: deps.gitRun ?? gitRun, defaultBranch: deps.gitRun ? async () => 'main' : null };
  const now = deps.now ?? (() => new Date());
  const { values } = parseCommandArgs(argv, { usage: USAGE, options: { all: { type: 'boolean' } } });
  const featureDir = resolveFeatureDir(ctx, values);
  const fj = fs.existsSync(path.join(featureDir, 'feature.json')) ? readFeatureJson(featureDir) : {};
  const { visual } = loadVisualConfig(ctx, featureDir);
  const specText = readText(path.join(featureDir, 'spec.md'), { optional: true });
  const catalog = buildCatalog(visual, specText);
  const all = Boolean(values.all);
  const ts = now().toISOString();

  if (catalog.length === 0) {
    const plan = { ts, all, catalog: false, selected: [], budget_s: 0, flows: [] };
    updateManifest(featureDir, (m) => { m.plan = plan; });
    output(ctx, values, {
      text: 'no catalog: ad-hoc mode',
      data: { message: 'no catalog: ad-hoc mode', catalog: false, screens: [], budget_s: 0, flows: [] },
    });
    return 0;
  }

  const { source, globs } = all ? { source: 'all', globs: [] } : await selectionSource(ctx, featureDir, fj, git);
  const screens = selectScreens(catalog, globs, all);
  const budget_s = typeof visual?.budget_s === 'number' ? visual.budget_s
    : screens.reduce((sum, s) => sum + screenLimit(s, visual), 0);
  const flows = groupFlows(screens);
  const plan = { ts, all, catalog: true, selected: screens.map((s) => s.id), budget_s, flows };
  updateManifest(featureDir, (m) => { m.plan = plan; });

  const lines = [`visual plan: ${screens.length}/${catalog.length} screens (source: ${source}), budget ${budget_s}s`];
  for (const s of screens) lines.push(`  ${s.id}  ${s.flow ?? s.route ?? 'ad-hoc'}  ${screenLimit(s, visual)}s`);
  for (const f of flows) lines.push(`  flow ${f.flow}: ${f.screens.join(', ')}`);
  output(ctx, values, {
    text: lines,
    data: {
      catalog: true, all, source, budget_s, flows,
      screens: screens.map((s) => ({ id: s.id, title: s.title, flow: s.flow, route: s.route, timeout_s: screenLimit(s, visual) })),
    },
  });
  return 0;
}
