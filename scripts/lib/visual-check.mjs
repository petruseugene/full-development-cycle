// `dev-cycle visual check <screen> --screenshot <png> [--hierarchy <file>]
//   [--measure <check>:<subject>=<number>]... [--source vision]
//   [--fail "<reason>"]... [--adhoc]`   (spec R9)
//
// Evaluates the screen's catalog checks (geometry from a Maestro hierarchy or
// DOM rects, pixels from the PNG, vision measures from the agent) with
// visual-checks.mjs and merges the results into verification/manifest.json.
//
// Merge rules (a CLI-computed value always wins):
//   - a result replaces the earlier result of the SAME check (type + subject);
//   - an `unmeasured` result never replaces a measured one;
//   - a vision result never replaces a CLI-computed (hierarchy/dom/pixels)
//     `fail`, so no later call can turn a CLI failure into a pass;
//   - results of other checks are left alone; --fail reasons append.

import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, output, parseCommandArgs, readText, resolveFeatureDir, resolveProjectRoot,
} from './core.mjs';
import { decodePngFile } from './png.mjs';
import {
  buildCatalog, loadVisualConfig, readManifest, resolveInside, touchActivity, updateManifest,
  verificationDir,
} from './visual-core.mjs';
import { evaluateChecks, parseDomRects, parseMaestroHierarchy, parseMeasure } from './visual-checks.mjs';
import { ID_RE } from './visual-profile.mjs';

const USAGE = 'visual check <screen> --screenshot <png> [--hierarchy <file>] [--measure <check>:<subject>=<number>]... [--source vision] [--fail "<reason>"]... [--adhoc] [--json] [--feature <dir>]';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (c) => `${c.type}\u0000${c.subject}`;

/** Resolve a screenshot/hierarchy path inside `vdir` (or, when allowed, the project root). */
function confine(ctx, vdir, root, p, { allowRoot = false } = {}) {
  let first;
  try {
    return resolveInside(vdir, p);
  } catch (err) {
    first = err;
  }
  if (!path.isAbsolute(p) && !p.split(/[\\/]/).includes('..')) {
    // a path relative to the cwd that lands inside verification/
    try { return resolveInside(vdir, path.resolve(ctx.cwd, p)); } catch { /* fall through */ }
  }
  if (allowRoot) {
    try { return resolveInside(root, path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p)); } catch { /* fall through */ }
  }
  throw first;
}

function requireFile(file, label) {
  let st;
  try { st = fs.statSync(file); } catch { throw new UsageError(`${label} not found: ${file}`); }
  if (!st.isFile()) throw new UsageError(`${label} is not a file: ${file}`);
}

function parseHierarchy(file) {
  const text = readText(file);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new UsageError(`hierarchy ${file}: invalid JSON (${e.message})`); }
  const isDom = isObject(json) && isObject(json.elements) && json.attributes === undefined && json.children === undefined;
  return isDom
    ? { boxes: parseDomRects(json), boxSource: 'dom' }
    : { boxes: parseMaestroHierarchy(json), boxSource: 'hierarchy' };
}

/**
 * Merge new results into the earlier ones (see the header for the rules).
 * @param {Array<Record<string, any>>} old
 * @param {Array<Record<string, any>>} fresh
 */
export function mergeResults(old, fresh) {
  const out = (Array.isArray(old) ? old : []).map((c) => ({ ...c }));
  for (const r of fresh) {
    const i = out.findIndex((o) => keyOf(o) === keyOf(r));
    if (i < 0) { out.push(r); continue; }
    const o = out[i];
    if (r.result === 'unmeasured' && o.result !== 'unmeasured') continue;
    if (r.source === 'vision' && o.source !== 'vision' && o.result === 'fail') continue;
    out[i] = r;
  }
  return out;
}

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  return runWith(argv, ctx);
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{now?: () => Date}} [deps]
 * @returns {Promise<number>}
 */
export async function runWith(argv, ctx, { now = () => new Date() } = {}) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      screenshot: { type: 'string', required: true },
      hierarchy: { type: 'string' },
      measure: { type: 'string', multiple: true },
      source: { type: 'string' },
      fail: { type: 'string', multiple: true },
      adhoc: { type: 'boolean' },
    },
    positionals: ['screen'],
  });
  const id = args.screen;
  // Same id rule as `visual mark` and the profile: no '/', '..', leading '-',
  // and never a prototype key such as __proto__ or constructor.
  if (!ID_RE.test(id)) throw new UsageError(`screen id '${id}' must match ${ID_RE}`);
  if (values.source !== undefined && values.source !== 'vision') {
    throw new UsageError(`bad --source '${values.source}': only 'vision' is supported`);
  }
  const measures = (values.measure || []).map(parseMeasure);
  const reasons = (values.fail || []).map((s) => s.trim());
  if (reasons.some((s) => s === '')) throw new UsageError('--fail needs a non-empty reason');

  const featureDir = resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  const vdir = verificationDir(featureDir);
  readManifest(featureDir); // creates verification/ with its self-ignore

  const shot = confine(ctx, vdir, root, values.screenshot);
  requireFile(shot, 'screenshot');
  const hierFile = values.hierarchy === undefined ? null : confine(ctx, vdir, root, values.hierarchy, { allowRoot: true });
  if (hierFile) requireFile(hierFile, 'hierarchy');

  const cfg = loadVisualConfig(ctx, featureDir);
  const specText = readText(path.join(featureDir, 'spec.md'), { optional: true });
  const catalog = buildCatalog(cfg.visual, specText);
  let screen = catalog.find((s) => s.id === id);
  let adhoc = false;
  if (!screen) {
    if (!values.adhoc) throw new UsageError(`unknown screen '${id}' (not in the catalog; pass --adhoc to register it)`);
    screen = { id, title: id, reference: 'none', checks: [] };
    adhoc = true;
  }

  const { boxes, boxSource } = hierFile ? parseHierarchy(hierFile) : { boxes: new Map(), boxSource: 'hierarchy' };
  const needsPixels = (screen.checks || []).some((c) => c.type === 'colors');
  const png = needsPixels ? decodePngFile(shot) : null;
  const results = evaluateChecks(screen, { visual: cfg.visual || {}, boxes, boxSource, png, measures });

  const rel = path.relative(fs.realpathSync(vdir), shot).split(path.sep).join('/');
  const iso = now().toISOString();
  let merged;
  let failures;
  updateManifest(featureDir, (m) => {
    m.screens = Object.assign(Object.create(null), isObject(m.screens) ? m.screens : {});
    const prev = Object.hasOwn(m.screens, id) && isObject(m.screens[id]) ? m.screens[id] : {};
    merged = mergeResults(prev.checks, results);
    failures = [...(Array.isArray(prev.failures) ? prev.failures : [])];
    for (const r of reasons) if (!failures.includes(r)) failures.push(r);
    m.screens[id] = {
      id,
      title: screen.title ?? id,
      reference: screen.reference ?? 'none',
      ...(Array.isArray(screen.acs) ? { acs: screen.acs } : {}),
      ...prev,
      ...(adhoc || prev.adhoc ? { adhoc: true } : {}),
      screenshot: rel,
      checks: merged,
      failures,
      updated_at: iso,
    };
    touchActivity(m, iso);
  });

  const text = [`visual check ${id}: ${merged.length} check(s), ${failures.length} failure reason(s)`];
  for (const c of merged) {
    const shown = c.measured === null ? 'n/a' : c.measured;
    text.push(`  ${c.result.toUpperCase().padEnd(10)} ${c.type} ${c.subject} measured=${shown} expected=${c.expected} tol=${c.tolerance} source=${c.source}`);
  }
  for (const f of failures) text.push(`  FAIL reason: ${f}`);
  output(ctx, values, { text, data: { screen: id, screenshot: rel, checks: merged, failures } });
  return 0;
}
