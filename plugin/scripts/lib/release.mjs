// Release helpers for `dev-cycle ship --release` (pure, no git):
// manifest detection + in-place version bump, semver inference, CHANGELOG
// insertion, --notes-file reading.
//
// Every version is validated against VERSION_RE before it is used in a
// manifest, the CHANGELOG or a tag name. Manifests are edited in place: only
// the version string is replaced, the rest of the bytes are untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './core.mjs';

export const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const LEVELS = Object.freeze(['major', 'minor', 'patch', 'auto']);
export const NOTES_MAX_BYTES = 64 * 1024;

/** Auto-detected root manifests, in order. */
export const ROOT_MANIFESTS = Object.freeze([
  '.claude-plugin/plugin.json', 'package.json', 'app.json', 'pyproject.toml', 'Cargo.toml',
]);

/** A release failure with a short reason (printed as `ship release: FAILED <reason> — <detail>`). */
export class ReleaseError extends Error {
  /** @param {string} reason @param {string} [detail] */
  constructor(reason, detail = '') {
    super(`${reason} — ${detail}`);
    this.name = 'ReleaseError';
    this.reason = reason;
    this.detail = detail;
  }
}

// --- JSON: locate a string value without reformatting -----------------------

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿';

function skipWs(t, i) {
  while (i < t.length && isWs(t[i])) i++;
  return i;
}

function scanString(t, i) {
  let j = i + 1;
  while (j < t.length) {
    if (t[j] === '\\') j += 2;
    else if (t[j] === '"') return j + 1;
    else j++;
  }
  throw new Error('unterminated string');
}

/** Index just past the JSON value starting at `i`; records the span of the string at path `keys`. */
function scanValue(t, i, keys, found) {
  i = skipWs(t, i);
  const c = t[i];
  if (c === '{') {
    i = skipWs(t, i + 1);
    if (t[i] === '}') return i + 1;
    for (;;) {
      i = skipWs(t, i);
      if (t[i] !== '"') throw new Error('expected key');
      const ke = scanString(t, i);
      const key = JSON.parse(t.slice(i, ke));
      i = skipWs(t, ke);
      if (t[i] !== ':') throw new Error('expected :');
      const vs = skipWs(t, i + 1);
      if (keys.length > 0 && key === keys[0]) {
        if (keys.length === 1) {
          const ve = scanValue(t, vs, [], null);
          if (t[vs] === '"' && !found.span) found.span = [vs, ve];
          i = ve;
        } else {
          i = scanValue(t, vs, keys.slice(1), found);
        }
      } else {
        i = scanValue(t, vs, [], null);
      }
      i = skipWs(t, i);
      if (t[i] === ',') { i++; continue; }
      if (t[i] === '}') return i + 1;
      throw new Error('expected , or }');
    }
  }
  if (c === '[') {
    i = skipWs(t, i + 1);
    if (t[i] === ']') return i + 1;
    for (;;) {
      i = scanValue(t, i, [], null);
      i = skipWs(t, i);
      if (t[i] === ',') { i++; continue; }
      if (t[i] === ']') return i + 1;
      throw new Error('expected , or ]');
    }
  }
  if (c === '"') return scanString(t, i);
  let j = i;
  while (j < t.length && !isWs(t[j]) && !',]}'.includes(t[j])) j++;
  if (j === i) throw new Error('unexpected token');
  return j;
}

/** [start, end) of the string literal at `keys`, or null. */
function jsonStringSpan(text, keys) {
  const found = { span: null };
  try { scanValue(text, 0, keys, found); } catch { return null; }
  return found.span;
}

// --- TOML: version line inside a given table --------------------------------

const TOML_VERSION_RE = /^(\s*version\s*=\s*)(["'])([^"'\r\n]*)\2/;

/** {line, start, end} of the first `version = "x"` in one of `tables`, or null. */
function tomlVersionLine(text, tables) {
  const lines = text.split('\n');
  let table = '';
  let offset = 0;
  for (const line of lines) {
    const arr = /^\s*\[\[/.test(line);
    const hdr = arr ? null : /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (arr) table = '[[array]]';
    else if (hdr) table = hdr[1].trim();
    else if (tables.includes(table)) {
      const m = TOML_VERSION_RE.exec(line);
      if (m) return { start: offset + m[1].length + 1, end: offset + m[1].length + 1 + m[3].length };
    }
    offset += line.length + 1;
  }
  return null;
}

// --- manifests ---------------------------------------------------------------

const KINDS = {
  'plugin.json': { json: ['version'] },
  'package.json': { json: ['version'] },
  'app.json': { json: ['expo', 'version'] },
  'pyproject.toml': { toml: ['project', 'tool.poetry'] },
  'Cargo.toml': { toml: ['package'] },
};

/** [start, end) of the version's characters in `text` for the manifest named `base`, or null. */
function versionSpan(base, text) {
  const kind = KINDS[base];
  if (!kind) return null;
  if (kind.json) {
    const span = jsonStringSpan(text, kind.json);
    return span ? [span[0] + 1, span[1] - 1] : null;
  }
  const s = tomlVersionLine(text, kind.toml);
  return s ? [s.start, s.end] : null;
}

/**
 * Read one manifest's version. Returns null when the file has no readable
 * version (e.g. a private package.json).
 * @param {string} file
 * @returns {{text: string, version: string}|null}
 */
export function readManifest(file) {
  const base = path.basename(file);
  const text = fs.readFileSync(file, 'utf8');
  const span = versionSpan(base, text);
  if (!span) return null;
  return { text, version: text.slice(span[0], span[1]) };
}

/** `text` with the manifest version replaced by `version` (validated). */
export function setManifestVersion(file, text, version) {
  if (!VERSION_RE.test(version)) throw new ReleaseError('invalid-version', `'${version}' is not x.y.z`);
  const span = versionSpan(path.basename(file), text);
  if (!span) throw new ReleaseError('no-manifest', `no version field in ${file}`);
  return text.slice(0, span[0]) + version + text.slice(span[1]);
}

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Marketplace-aware detection: for each plugin entry of the root
 * `.claude-plugin/marketplace.json` with a string `source` other than `./`
 * whose manifest resolves (realpath) inside the project root, use `<source>/.claude-plugin/plugin.json`
 * when it exists and carries a version. Pushes into `out`; returns true when
 * at least one was found (otherwise the caller keeps the root-manifest behaviour).
 * @param {string} root @param {string} realRoot @param {Array<object>} out
 */
function marketplaceManifests(root, realRoot, out) {
  let plugins;
  try {
    const mp = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    plugins = mp && Array.isArray(mp.plugins) ? mp.plugins : [];
  } catch { return false; }
  const seen = new Set();
  for (const entry of plugins) {
    const source = entry && entry.source;
    if (typeof source !== 'string' || path.isAbsolute(source)) continue;
    const dir = path.resolve(root, source);
    if (dir === path.resolve(root)) continue;
    const abs = path.join(dir, '.claude-plugin', 'plugin.json');
    let real;
    try { real = fs.realpathSync(abs); } catch { continue; }
    if (!inside(realRoot, real) || seen.has(real)) continue;
    const m = readManifest(real);
    if (!m) continue;
    seen.add(real);
    out.push({ rel: path.relative(realRoot, real).split(path.sep).join('/'), abs: real, ...m });
  }
  return out.length > 0;
}

/**
 * Resolve the manifests to bump. Explicit paths must be known manifest
 * names inside the project root; otherwise every root manifest that exists
 * and carries a version.
 * @param {string} root  project root
 * @param {string[]} [explicit]
 * @returns {Array<{rel: string, abs: string, text: string, version: string}>}
 */
export function loadManifests(root, explicit = []) {
  const realRoot = fs.realpathSync(root);
  const out = [];
  if (explicit.length) {
    for (const p of explicit) {
      const abs = path.resolve(root, p);
      let real;
      try { real = fs.realpathSync(abs); } catch { throw new ReleaseError('no-manifest', `${p} does not exist`); }
      if (!inside(realRoot, real)) throw new UsageError(`--manifest ${p} is outside the project root`);
      if (!Object.hasOwn(KINDS, path.basename(real))) {
        throw new UsageError(`--manifest ${p}: unsupported manifest (use ${Object.keys(KINDS).join(', ')})`);
      }
      const m = readManifest(real);
      if (!m) throw new ReleaseError('no-manifest', `no version field in ${p}`);
      out.push({ rel: path.relative(realRoot, real).split(path.sep).join('/'), abs: real, ...m });
    }
  } else if (marketplaceManifests(root, realRoot, out)) {
    // bumped from the marketplace's local plugin sources (D2)
  } else {
    for (const rel of ROOT_MANIFESTS) {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) continue;
      let real;
      try { real = fs.realpathSync(abs); } catch { continue; }
      if (!inside(realRoot, real)) continue;
      const m = readManifest(real);
      if (m) out.push({ rel, abs: real, ...m });
    }
  }
  if (out.length === 0) {
    throw new ReleaseError('no-manifest', `none of ${ROOT_MANIFESTS.join(', ')} found with a version`);
  }
  return out;
}

/**
 * The one version all manifests agree on.
 * @param {Array<{rel: string, version: string}>} manifests
 * @returns {string}
 */
export function agreedVersion(manifests) {
  const bad = manifests.find((m) => !VERSION_RE.test(m.version));
  if (bad) throw new ReleaseError('invalid-version', `${bad.rel} has version '${bad.version}' (need x.y.z)`);
  const set = new Set(manifests.map((m) => m.version));
  if (set.size > 1) {
    throw new ReleaseError('version-mismatch', manifests.map((m) => `${m.rel}=${m.version}`).join(', '));
  }
  return manifests[0].version;
}

// --- semver ------------------------------------------------------------------

/** Parse a conventional-commit message: {type, breaking}. */
export function parseCommit(message) {
  const text = String(message ?? '');
  const subject = text.split('\n')[0];
  const m = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(subject);
  const breaking = Boolean(m?.[2]) || /^BREAKING[ -]CHANGE\b/m.test(text);
  return { type: m ? m[1].toLowerCase() : '', breaking };
}

/**
 * Bump level for a set of commit messages (highest wins).
 * `!`/BREAKING → major; everything else, including feat, → patch (small
 * features bump the third number; pass `--release minor` explicitly for a
 * minor bump). On 0.x a breaking change bumps minor, never major.
 * @param {string[]} messages
 * @param {string} current
 * @returns {'major'|'minor'|'patch'}
 */
export function inferLevel(messages, current) {
  const breaking = messages.some((msg) => parseCommit(msg).breaking);
  if (!breaking) return 'patch';
  return current.startsWith('0.') ? 'minor' : 'major';
}

/** Next version for a level (never `auto`). */
export function bumpVersion(current, level) {
  if (!VERSION_RE.test(current)) throw new ReleaseError('invalid-version', `'${current}' is not x.y.z`);
  const [maj, min, pat] = current.split('.').map(Number);
  let next;
  if (level === 'major') next = `${maj + 1}.0.0`;
  else if (level === 'minor') next = `${maj}.${min + 1}.0`;
  else if (level === 'patch') next = `${maj}.${min}.${pat + 1}`;
  else throw new UsageError(`unknown bump level '${level}'`);
  return next;
}

// --- CHANGELOG ---------------------------------------------------------------

/** `### Added|Fixed|Changed` + one bullet for a conventional-commit subject. */
export function subjectNotes(subject) {
  const { type } = parseCommit(subject);
  const section = type === 'feat' ? 'Added' : type === 'fix' ? 'Fixed' : 'Changed';
  return `### ${section}\n\n- ${String(subject).split('\n')[0].trim()}\n`;
}

/** True when the first section is `## [Unreleased]` and its body is not empty. */
export function unreleasedHasEntries(text) {
  if (text === null || text === undefined) return false;
  const lines = text.split('\n');
  const first = lines.findIndex((l) => /^## /.test(l));
  if (first === -1 || !/^## \[Unreleased\]\s*$/i.test(lines[first])) return false;
  let next = lines.findIndex((l, i) => i > first && /^## /.test(l));
  if (next === -1) next = lines.length;
  return lines.slice(first + 1, next).join('\n').trim() !== '';
}

/** Local date as YYYY-MM-DD. */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Insert a release section into a CHANGELOG.
 *  - absent file (`text === null`): `# Changelog` + the section;
 *  - first section `## [Unreleased]`: its heading becomes the version heading
 *    and its body follows the notes;
 *  - otherwise the section goes before the first `## ` heading (after the
 *    preamble), or at the end when there is none.
 * @param {string|null} text
 * @param {string} version
 * @param {string} date
 * @param {string} notes  body, inserted verbatim (may be empty: the Unreleased body is promoted as-is)
 */
export function insertChangelog(text, version, date, notes) {
  if (!VERSION_RE.test(version)) throw new ReleaseError('invalid-version', `'${version}' is not x.y.z`);
  const heading = `## [${version}] — ${date}`;
  const body = String(notes).replace(/\s+$/, '');
  const section = body === '' ? `${heading}\n` : `${heading}\n\n${body}\n`;
  if (text === null) return `# Changelog\n\n${section}`;

  const lines = text.split('\n');
  const first = lines.findIndex((l) => /^## /.test(l));
  if (first === -1) {
    const pre = text.replace(/\s+$/, '');
    return `${pre === '' ? '# Changelog' : pre}\n\n${section}`;
  }
  const before = lines.slice(0, first).join('\n');
  const prefix = before === '' ? '' : `${before.replace(/\n*$/, '')}\n\n`;
  if (/^## \[Unreleased\]\s*$/i.test(lines[first])) {
    let next = lines.findIndex((l, i) => i > first && /^## /.test(l));
    if (next === -1) next = lines.length;
    const oldBody = lines.slice(first + 1, next).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    const rest = lines.slice(next).join('\n');
    const kept = oldBody === '' ? '' : `\n${oldBody}\n`;
    return `${prefix}${section}${kept}${rest === '' ? '' : `\n${rest}`}`;
  }
  return `${prefix}${section}\n${lines.slice(first).join('\n')}`;
}

// --- --notes-file ------------------------------------------------------------

/**
 * Read a notes file as data: a regular file of at most 64 KB whose realpath
 * is inside the project root or the OS temp dir. Content is returned verbatim.
 * @param {string} file
 * @param {{root: string, cwd?: string, env?: Record<string,string|undefined>}} where
 * @returns {string}
 */
export function readNotesFile(file, { root, cwd = root, env = {} }) {
  const abs = path.resolve(cwd, file);
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new UsageError(`--notes-file ${file}: cannot read`); }
  const allowed = [root, os.tmpdir(), env.TMPDIR].filter(Boolean).map((d) => {
    try { return fs.realpathSync(d); } catch { return null; }
  }).filter(Boolean);
  if (!allowed.some((d) => real === d || inside(d, real))) {
    throw new UsageError(`--notes-file ${file}: must be inside the project or the temp dir`);
  }
  let fd;
  try {
    fd = fs.openSync(real, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UsageError(`--notes-file ${file}: not a regular file`);
    if (st.size > NOTES_MAX_BYTES) throw new UsageError(`--notes-file ${file}: larger than ${NOTES_MAX_BYTES} bytes`);
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString('utf8');
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`--notes-file ${file}: cannot read (${err?.code ?? err?.message})`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
