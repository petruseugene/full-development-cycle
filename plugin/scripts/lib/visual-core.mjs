// Shared core for the `dev-cycle visual <sub>` family (spec R3–R5, R12;
// constraints "Security"). Every scripts/lib/visual-<sub>.mjs builds on it:
//
//   loadVisualConfig(ctx, featureDir) → {visual, platform, source} (validated)
//   buildCatalog(visual, specText)    → screens[] (profile + spec `## Screens`)
//   verificationDir(featureDir) / cacheDir(root)
//   ensureSelfIgnore(dir)             → dir with a `.gitignore` containing `*`
//   resolveInside(base, p)            → absolute real path confined to base
//   readManifest(featureDir) / updateManifest(featureDir, mutator)
//   screenLimit(screen, visual) / touchActivity(manifest, iso)
//
// `verification/manifest.json` schema (v1). Writers update only their own keys:
//
//   {
//     "version": 1,
//     "last_activity": "<ISO, latest run/mark/check>",
//     "plan":  { "ts": "…", "all": false, "catalog": true, "selected": ["id"], "budget_s": 360,
//                "flows": [{ "flow": "<cmd>", "screens": ["id"] }] },            // visual plan
//     "build": { "status": "built|cached|failed", "hash": "<sha256>", "ts": "…",
//                "log": "build.log" },                                          // visual build
//     "screens": { "<id>": {
//         "id": "…", "title": "…", "reference": "<repo-rel>|none", "acs": ["AC3"], "adhoc": false,
//         "target": "<device id|breakpoint|web>", "timeout_s": 180,
//         "started_at": "…", "ended_at": "…", "duration_s": 12.3, "exit_code": 0,
//         "timed_out": false, "overrun": false, "result": "timeout",          // visual run / mark
//         "screenshot": "<path relative to verification/>",
//         "checks": [{ "type": "scale", "subject": "friend/hero", "measured": 0.85,
//                      "expected": 1.0, "tolerance": 10,
//                      "source": "hierarchy|dom|pixels|vision",
//                      "result": "pass|fail|unmeasured" }],
//         "failures": ["console error: …"],                                   // visual check
//         "updated_at": "…" } },
//     "verdict": { "status": "PASSED|FAILED", "ts": "…", "run_time_s": 0, "budget_s": 0,
//                  "passed": 1, "total": 2, "reasons": ["no-teardown"] }       // visual verdict
//   }
//
// Related files owned elsewhere: `.dev-cycle/cache/visual-started.json`
// (device lifecycle) and `verification/teardown.json` (visual teardown).

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, atomicWrite, readText, resolveProjectRoot } from './core.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { loadProfile } from './profile.mjs';
import { ID_RE, VISUAL_PLACEHOLDERS, validateVisual, visualCmdProblems } from './visual-profile.mjs';
import { parseAcIds } from './brief.mjs';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const DEFAULT_SCREEN_TIMEOUT_S = 180;
/** Placeholders a visual command (flow, build, teardown) may use (one list: visual-profile). */
export { VISUAL_PLACEHOLDERS };

const SCREEN_ID_RE = ID_RE;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const EMPTY_CELL_RE = /^(?:|-|–|—)$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------
// Config (R3)
// ---------------------------------------------------------------------------

/**
 * The visual config for a feature: the `feature.json.profile.visual`
 * snapshot first, else the live `.dev-cycle/project.json` `visual`.
 * `platform` comes from feature.json, else the profile, else 'web'.
 * @param {import('./core.mjs').CliContext} ctx
 * @param {string} featureDir
 * @returns {{visual: Record<string, any>|null, platform: string, source: 'snapshot'|'profile'|'none'}}
 */
export function loadVisualConfig(ctx, featureDir) {
  let fj = {};
  if (fs.existsSync(path.join(featureDir, 'feature.json'))) fj = readFeatureJson(featureDir);
  const snap = fj?.profile?.visual;
  let live = null;
  if (!isObject(snap) || typeof fj.platform !== 'string') {
    live = loadProfile(ctx, { quiet: true }).profile;
  }
  const platform = typeof fj.platform === 'string' ? fj.platform
    : (typeof live?.platform === 'string' ? live.platform : 'web');
  if (isObject(snap)) {
    // The snapshot is repo content too: same validator as the profile (ids,
    // commands, device guard), so nothing unvalidated reaches a path or argv.
    const { errors } = validateVisual(snap);
    if (errors.length) {
      throw new UsageError(`invalid feature.json profile.visual snapshot in ${featureDir}:\n  - ${errors.join('\n  - ')}`);
    }
    return { visual: snap, platform, source: 'snapshot' };
  }
  if (isObject(live?.visual)) return { visual: live.visual, platform, source: 'profile' };
  return { visual: null, platform, source: 'none' };
}

// ---------------------------------------------------------------------------
// Catalog (R4)
// ---------------------------------------------------------------------------

function cell(raw) {
  let v = raw.trim();
  const m = /^`([^`]*)`$/.exec(v);
  if (m) v = m[1].trim();
  return EMPTY_CELL_RE.test(v) ? '' : v;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|');
}

/** Problems of a reference path (absolute, `..`, URL scheme), or []. */
export function referenceProblems(ref) {
  if (typeof ref !== 'string' || ref === '' || ref === 'none') return [];
  const out = [];
  if (path.isAbsolute(ref) || /^[\\/]/.test(ref) || /^[A-Za-z]:[\\/]/.test(ref)) out.push('is absolute');
  if (ref.split(/[\\/]/).includes('..')) out.push("contains '..'");
  if (URL_SCHEME_RE.test(ref) && !/^[A-Za-z]:[\\/]/.test(ref)) out.push('has a URL scheme');
  return out;
}

/**
 * Parse the optional `## Screens` table of spec.md:
 * `| id | route or flow | reference | touches | acs |`. A target starting
 * with `/` is a route, anything else a flow (validated with visualCmdProblems,
 * the same every-word check as the profile). Empty cells (`''`, `-`, `—`) leave the field unset. Values may be
 * wrapped in backticks. Invalid rows throw a UsageError naming the row.
 * @param {string|null|undefined} specText
 * @returns {Array<{id: string, route?: string, flow?: string, reference?: string,
 *   touches?: string[], acs?: string[]}>}
 */
export function parseSpecScreens(specText) {
  if (typeof specText !== 'string' || specText === '') return [];
  const lines = specText.split(/\r?\n/);
  let inSection = false;
  let fence = false;
  let header = false;
  const rows = [];
  const errors = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^##\s/.test(line)) {
      if (inSection) break;
      inSection = /^##\s+Screens\s*$/i.test(line);
      continue;
    }
    if (!inSection || !line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (!header) { header = true; continue; } // column header row
    if (cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c))) continue; // separator row
    const [id = '', target = '', reference = '', touches = '', acs = ''] = cells.map(cell);
    const where = `spec ## Screens row '${line.trim()}'`;
    if (!SCREEN_ID_RE.test(id)) { errors.push(`${where}: id '${id}' must match ${SCREEN_ID_RE}`); continue; }
    if (rows.some((r) => r.id === id)) { errors.push(`${where}: duplicate id '${id}'`); continue; }
    const row = { id };
    if (target) {
      if (target.startsWith('/')) {
        row.route = target;
      } else {
        const p = visualCmdProblems(target);
        if (p.length) { errors.push(`${where}: flow: ${p.join('; ')}`); continue; }
        row.flow = target;
      }
    }
    if (reference) {
      const p = referenceProblems(reference);
      if (p.length) { errors.push(`${where}: reference '${reference}' ${p.join(', ')}`); continue; }
      row.reference = reference;
    }
    if (touches) row.touches = touches.split(',').map((t) => t.trim()).filter(Boolean);
    if (acs) {
      try {
        row.acs = parseAcIds(acs).map((n) => `AC${n}`);
      } catch (err) {
        errors.push(`${where}: ${err.message}`);
        continue;
      }
    }
    rows.push(row);
  }
  if (errors.length) throw new UsageError(`invalid spec ## Screens table:\n  - ${errors.join('\n  - ')}`);
  return rows;
}

/**
 * The screen catalog in catalog order (R4): the profile `visual.screens[]`
 * first, then new screens from the spec `## Screens` table in table order.
 * A spec row with an existing id overrides only the fields it sets (a route
 * replaces a flow and vice versa); a new id adds a screen without checks.
 * Returns deep copies; the inputs are never modified.
 * @param {Record<string, any>|null|undefined} visual
 * @param {string|null|undefined} specText
 * @returns {Array<Record<string, any>>}
 */
export function buildCatalog(visual, specText) {
  const screens = Array.isArray(visual?.screens) ? visual.screens.filter(isObject).map(clone) : [];
  for (const row of parseSpecScreens(specText)) {
    let screen = screens.find((s) => s.id === row.id);
    if (!screen) {
      screen = { id: row.id };
      screens.push(screen);
    }
    if (row.route !== undefined) { screen.route = row.route; delete screen.flow; }
    if (row.flow !== undefined) { screen.flow = row.flow; delete screen.route; }
    for (const k of ['reference', 'touches', 'acs']) if (row[k] !== undefined) screen[k] = row[k];
  }
  return screens;
}

// ---------------------------------------------------------------------------
// Folders + self-ignore
// ---------------------------------------------------------------------------

/** `<feature>/verification` */
export function verificationDir(featureDir) {
  return path.join(featureDir, 'verification');
}

/** `<root>/.dev-cycle/cache`; `root` is a path or a CliContext. */
export function cacheDir(root) {
  const base = typeof root === 'string' ? root : resolveProjectRoot(root);
  return path.join(base, '.dev-cycle', 'cache');
}

/**
 * Create `dir` and make git ignore everything in it: a `.gitignore` with a
 * `*` line. Idempotent; appends `*` to an existing `.gitignore` without one.
 * @param {string} dir
 * @returns {string} dir
 */
export function ensureSelfIgnore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.gitignore');
  const text = readText(file, { optional: true });
  if (text === null) {
    atomicWrite(file, '*\n');
  } else if (!text.split(/\r?\n/).some((l) => l.trim() === '*')) {
    atomicWrite(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}*\n`, { expected: text });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Path guard
// ---------------------------------------------------------------------------

function isWithin(base, p) {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** realpath of `p`, or of its nearest existing ancestor joined with the rest. */
function realpathLoose(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `p` (relative to `base`, or absolute) and confine it to `base`.
 * Returns the absolute real path (symlinks resolved; a not-yet-existing tail
 * is kept). Throws a UsageError (exit 2) when `p` is empty, contains a `..`
 * segment, is absolute outside `base`, or resolves (through a symlink)
 * outside `base`.
 * @param {string} base
 * @param {string} p
 * @returns {string}
 */
export function resolveInside(base, p) {
  if (typeof p !== 'string' || p.trim() === '' || p.includes('\0')) {
    throw new UsageError(`path must be a non-empty string: ${JSON.stringify(p)}`);
  }
  const absBase = path.resolve(base);
  const realBase = realpathLoose(absBase);
  if (p.split(/[\\/]/).includes('..')) {
    throw new UsageError(`path '${p}' contains '..': it must stay inside ${absBase}`);
  }
  const candidate = path.resolve(absBase, p);
  const lexicalOk = isWithin(absBase, candidate) || isWithin(realBase, candidate);
  if (!lexicalOk) throw new UsageError(`path '${p}' is outside ${absBase}`);
  const real = realpathLoose(candidate);
  if (!isWithin(realBase, real)) {
    throw new UsageError(`path '${p}' resolves (via a symlink) outside ${absBase}`);
  }
  return real;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function manifestPath(featureDir) {
  return path.join(verificationDir(featureDir), MANIFEST_FILE);
}

function parseManifest(text, file) {
  if (text === null || text.trim() === '') return { version: MANIFEST_VERSION };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${file}: ${err.message}`);
  }
  if (!isObject(obj)) throw new UsageError(`${file} must contain a JSON object`);
  if (obj.version !== undefined && obj.version !== MANIFEST_VERSION) {
    throw new UsageError(`${file}: unsupported manifest version ${JSON.stringify(obj.version)} (expected ${MANIFEST_VERSION})`);
  }
  return obj;
}

/**
 * Read `verification/manifest.json` (self-ignoring the folder first).
 * Missing file → `{version: 1}`.
 * @param {string} featureDir
 * @returns {Record<string, any>}
 */
export function readManifest(featureDir) {
  ensureSelfIgnore(verificationDir(featureDir));
  const file = manifestPath(featureDir);
  return parseManifest(readText(file, { optional: true }), file);
}

/**
 * Read-modify-write the manifest atomically. `mutator(manifest)` changes it
 * in place or returns a replacement. The file is re-read before the rename;
 * a concurrent change is a UsageError and nothing is written. A throwing
 * mutator leaves the file untouched. Returns the written manifest.
 * @param {string} featureDir
 * @param {(m: Record<string, any>) => (Record<string, any>|void)} mutator
 */
export function updateManifest(featureDir, mutator) {
  ensureSelfIgnore(verificationDir(featureDir));
  const file = manifestPath(featureDir);
  const before = readText(file, { optional: true });
  const obj = parseManifest(before, file);
  const result = mutator(obj);
  const next = isObject(result) ? result : obj;
  next.version = MANIFEST_VERSION;
  atomicWrite(file, JSON.stringify(next, null, 2) + '\n', { expected: before });
  return next;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Per-screen soft limit in seconds. */
export function screenLimit(screen, visual) {
  return screen?.timeout_s ?? visual?.screen_timeout_s ?? DEFAULT_SCREEN_TIMEOUT_S;
}

/** Record the latest run/mark/check time on the manifest. */
export function touchActivity(manifest, iso) {
  manifest.last_activity = iso;
  return manifest;
}
