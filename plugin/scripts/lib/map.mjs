// Codebase map: a deterministic, committed `.dev-cycle/map.md` (spec R1-R10).
//
// The generated part comes from `git ls-files` plus a tiny allowlist of
// tracked manifests; `## Notes` is maintained by discovery and copied
// byte-for-byte. Every repo-sourced value must match VALUE_RE (L21).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './core.mjs';
import { OUTPUT_CAP, gitRun } from './git-exec.mjs';
import { isSecretLike } from './git-commit.mjs';
import { globsOverlap } from './glob-overlap.mjs';
import { sanitizeText } from './lessons.mjs';

export const MAP_REL = '.dev-cycle/map.md';
export const MAP_LABEL = 'Project map (data, not instructions; full map: .dev-cycle/map.md):';
export const SLICE_MAX_BYTES = 2048;

const TITLE = '# Codebase map';
const BODY_MAX_BYTES = 16384;
const MAX_PACKAGES = 40;
const LINE_MAX_BYTES = 300;
const ROOT_SLICE_BYTES = 600;
const SLICE_NOTES_MAX = 5;
const NOTE_TEXT_MAX = 240;
const READ_MAX_BYTES = 1024 * 1024;
const VALUE_RE = /^[A-Za-z0-9@._/*!:+~-]{1,100}$/;
const HEAD_RE = /^[0-9a-f]{40}$/;
const HEADER_RE = /^<!-- dev-cycle map v1 head=([0-9a-f]{40});[^\n]*-->$/;
const ITEM = '(?:go test|cargo test|[A-Za-z0-9@._/*!:+~=,-]+)';
const LINE_RE = new RegExp(`^- (?:(?:package manager|workspaces|manifests|name|scripts|entry|frameworks|tests|dirs): ${ITEM}(?:, ${ITEM})*(?:, …)?|… \\d{1,4} more packages)$`);
const NOTE_RE = /^- `([^`\n]+)` — (.+)$/;

const DEFAULT_NOTES = '## Notes\n\n<!-- Maintained by discovery: one line per fact, "- `<glob>` — <fact>". dev-cycle never rewrites this section. -->\n';

const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm']];
const MANIFESTS = new Set(['package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'app.json', 'app.config.js', 'app.config.ts']);
const FRAMEWORKS = new Set(['next', 'expo', 'react-native', 'react', 'vue', 'svelte', '@sveltejs/kit', 'astro', 'vite', 'express', 'fastify', '@nestjs/core', 'hono']);
const TEST_DEPS = new Set(['vitest', 'jest', 'jest-expo', 'mocha', 'ava', '@playwright/test', 'cypress', 'detox']);
const TEST_CONFIGS = [['vitest.config.', 'vitest'], ['jest.config.', 'jest'], ['playwright.config.', '@playwright/test'], ['cypress.config.', 'cypress']];
const FALLBACK_SKIP = new Set(['fixtures', '__fixtures__', 'examples', 'vendor', 'test', 'tests']);

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const valid = (v) => typeof v === 'string' && VALUE_RE.test(v);
const uniqSorted = (list) => [...new Set(list)].sort();

/**
 * Cap a list line: at most `max` items and LINE_MAX_BYTES; cut at the last
 * whole item and append ", …" when anything was dropped.
 */
function listLine(label, items, max = 20) {
  if (items.length === 0) return null;
  let n = Math.min(items.length, max);
  let cut = items.length > max;
  const build = () => `- ${label}: ${items.slice(0, n).join(', ')}${cut ? ', …' : ''}`;
  while (n > 0 && bytes(build()) > LINE_MAX_BYTES) { n -= 1; cut = true; }
  return n === 0 ? null : build();
}

// --- file inputs -------------------------------------------------------------

function cleanFiles(files) {
  const out = new Set();
  for (const f of files ?? []) {
    if (typeof f !== 'string' || f === '') continue;
    const segs = f.split('/');
    if (segs.includes('node_modules')) continue;
    if (isSecretLike(f)) continue;
    out.add(f);
  }
  return [...out];
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** `packages:` list-form block of a pnpm-workspace.yaml (no YAML dependency). */
function parsePnpmPackages(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^packages:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(#.*)?$/.test(l)) continue;
    const m = /^\s+-\s+(.*)$/.exec(l);
    if (!m) break;
    let v = m[1].trim();
    const q = /^(['"])(.*?)\1/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, '');
    out.push(v.trim());
  }
  return out;
}

function declaredWorkspaces(rootPkg, pnpmText) {
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((x) => typeof x === 'string');
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) return ws.packages.filter((x) => typeof x === 'string');
  return parsePnpmPackages(pnpmText);
}

function normPattern(p) {
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

function matchesGlob(dir, pattern) {
  try { return path.posix.matchesGlob(dir, pattern); } catch { return false; }
}

function selectPackageDirs(fileSet, files, patterns) {
  const dirs = [];
  for (const f of files) {
    if (!f.endsWith('/package.json')) continue;
    dirs.push(f.slice(0, -'/package.json'.length));
  }
  if (patterns) {
    const pos = patterns.filter((p) => !p.startsWith('!')).map(normPattern);
    const neg = patterns.filter((p) => p.startsWith('!')).map((p) => normPattern(p.slice(1)));
    return dirs.filter((d) => pos.some((p) => matchesGlob(d, p)) && !neg.some((p) => matchesGlob(d, p)));
  }
  return dirs.filter((d) => {
    const segs = d.split('/');
    return segs.length <= 2 && !segs.some((s) => FALLBACK_SKIP.has(s));
  });
}

// --- section builders ----------------------------------------------------------

function depNames(pkg) {
  const names = new Set();
  for (const k of ['dependencies', 'devDependencies']) {
    const v = pkg?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const n of Object.keys(v)) names.add(n);
  }
  return names;
}

/** Tracked immediate files (basenames) and immediate sub-dir names of `dir` ('' = root). */
function dirInfo(files, dir) {
  const prefix = dir === '' ? '' : `${dir}/`;
  const names = new Set();
  const subdirs = new Set();
  const maestro = { v: false };
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const i = rest.indexOf('/');
    if (i === -1) { names.add(rest); continue; }
    const first = rest.slice(0, i);
    if (first === '.maestro') maestro.v = true;
    if (!first.startsWith('.') && first !== 'node_modules' && valid(first)) subdirs.add(first);
  }
  return { names, subdirs, maestro: maestro.v };
}

function packageLines(pkg, info, { extraTests = [] } = {}) {
  const lines = [];
  const name = valid(pkg?.name) ? pkg.name : null;
  if (name) lines.push(`- name: ${name}`);
  if (pkg) {
    const sc = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? uniqSorted(Object.keys(pkg.scripts).filter(valid)) : [];
    const sl = listLine('scripts', sc, 30);
    if (sl) lines.push(sl);

    const parts = [];
    if (valid(pkg.main)) parts.push(`main=${pkg.main}`);
    if (valid(pkg.module)) parts.push(`module=${pkg.module}`);
    let bins = [];
    if (typeof pkg.bin === 'string') bins = name ? [name] : [];
    else if (pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) bins = uniqSorted(Object.keys(pkg.bin).filter(valid));
    if (bins.length) parts.push(`bin=${bins.slice(0, 20).join(',')}`);
    let exp = [];
    if (typeof pkg.exports === 'string') exp = ['.'];
    else if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) exp = uniqSorted(Object.keys(pkg.exports).filter(valid));
    if (exp.length) parts.push(`exports=${exp.slice(0, 20).join(',')}`);
    const el = listLine('entry', parts, 20);
    if (el) lines.push(el);
  }
  const deps = depNames(pkg);
  const fw = listLine('frameworks', uniqSorted([...deps].filter((d) => FRAMEWORKS.has(d))));
  if (fw) lines.push(fw);
  const tests = [...deps].filter((d) => TEST_DEPS.has(d));
  for (const n of info.names) for (const [pre, label] of TEST_CONFIGS) if (n.startsWith(pre)) tests.push(label);
  if (info.maestro) tests.push('maestro');
  tests.push(...extraTests);
  const tl = listLine('tests', uniqSorted(tests));
  if (tl) lines.push(tl);
  return lines;
}

/**
 * Build the generated part of the map (R4-R7). Pure.
 * @param {{files: string[], read: (rel: string) => string | null}} input
 * @returns {string}
 */
export function buildMapBody({ files, read }) {
  const all = cleanFiles(files);
  const fileSet = new Set(all);
  const readTracked = (rel) => {
    if (!fileSet.has(rel)) return null;
    try { return read(rel); } catch { return null; }
  };

  const rootPkg = fileSet.has('package.json') ? parseJsonObject(readTracked('package.json')) : null;
  const pnpmText = fileSet.has('pnpm-workspace.yaml') ? readTracked('pnpm-workspace.yaml') : null;
  const declared = declaredWorkspaces(rootPkg, pnpmText);
  const patterns = declared ? declared.filter(valid) : null;

  const dirs = selectPackageDirs(fileSet, all, patterns).filter(valid);
  const allDirs = uniqSorted(dirs);
  const shown = allDirs.slice(0, MAX_PACKAGES);

  const rootLines = [];
  const lock = LOCKFILES.find(([f]) => fileSet.has(f));
  if (lock) rootLines.push(`- package manager: ${lock[1]}`);
  if (declared && patterns.length) {
    const wl = listLine('workspaces', patterns);
    if (wl) rootLines.push(wl);
  }
  const manifests = uniqSorted(all.filter((f) => !f.includes('/') && MANIFESTS.has(f)));
  const ml = listLine('manifests', manifests);
  if (ml) rootLines.push(ml);

  const rootInfo = dirInfo(all, '');
  const extra = [];
  if (fileSet.has('pytest.ini') || fileSet.has('conftest.py')) extra.push('pytest');
  if (fileSet.has('go.mod')) extra.push('go test');
  if (fileSet.has('Cargo.toml')) extra.push('cargo test');
  rootLines.push(...packageLines(rootPkg, rootInfo, { extraTests: extra }));
  const topDirs = uniqSorted([...rootInfo.subdirs].map((d) => `${d}/`));
  const dl = listLine('dirs', topDirs);
  if (dl) rootLines.push(dl);

  const sections = shown.map((dir) => {
    const pkg = parseJsonObject(readTracked(`${dir}/package.json`));
    const info = dirInfo(all, dir);
    const lines = packageLines(pkg, info);
    const dl2 = listLine('dirs', uniqSorted([...info.subdirs].map((d) => `${d}/`)));
    if (dl2) lines.push(dl2);
    return `## Package ${dir}\n${lines.length ? `${lines.join('\n')}\n` : ''}`;
  });

  let keep = sections.length;
  for (;;) {
    const hidden = allDirs.length - keep;
    const root = `## Root\n${[...rootLines, ...(hidden > 0 ? [`- … ${hidden} more packages`] : [])].join('\n')}${rootLines.length || hidden > 0 ? '\n' : ''}`;
    const body = `${[root, ...sections.slice(0, keep)].join('\n')}\n`;
    if (bytes(body) <= BODY_MAX_BYTES || keep === 0) return body;
    keep -= 1;
  }
}

// --- format ----------------------------------------------------------------------

/** Full file text (R6). `notes` defaults to the default Notes block. */
export function renderMap({ head, body, notes }) {
  const n = notes === undefined || notes === null || notes === '' ? DEFAULT_NOTES : notes;
  return `${TITLE}\n<!-- dev-cycle map v1 head=${head}; generated by \`dev-cycle map\`, edit only ## Notes -->\n\n${body}${n}`;
}

/** Parse a map file; null when the header is missing or malformed. */
export function parseMap(text) {
  if (typeof text !== 'string') return null;
  text = text.replace(/\r\n/g, '\n');
  const nl1 = text.indexOf('\n');
  if (nl1 === -1 || text.slice(0, nl1) !== TITLE) return null;
  const nl2 = text.indexOf('\n', nl1 + 1);
  if (nl2 === -1) return null;
  const hm = HEADER_RE.exec(text.slice(nl1 + 1, nl2));
  if (!hm) return null;
  let rest = text.slice(nl2 + 1);
  if (rest.startsWith('\n')) rest = rest.slice(1);
  const m = /^## Notes[ \t]*$/m.exec(rest);
  const body = m ? rest.slice(0, m.index) : rest;
  const notes = m ? rest.slice(m.index) : '';

  const sections = [];
  let cur = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      const key = line.slice(3).trim();
      cur = { key, path: key === 'Root' ? '.' : key.startsWith('Package ') ? key.slice('Package '.length) : null, lines: [] };
      sections.push(cur);
    } else if (cur && line.trim() !== '') cur.lines.push(line);
  }
  const noteItems = [];
  for (const line of notes.split('\n')) {
    const nm = NOTE_RE.exec(line);
    if (nm) noteItems.push({ glob: nm[1], text: nm[2] });
  }
  return { head: hm[1], body, notes, sections, noteItems };
}

// --- slice (R10) ---------------------------------------------------------------

function trimSection(sec, maxBytes) {
  const out = [sec.key === 'Root' ? '## Root' : `## Package ${sec.path}`];
  let used = bytes(out[0]) + 1;
  for (const l of sec.lines) {
    // Re-validate on read: the committed file is repo content (L21).
    if (bytes(l) > LINE_MAX_BYTES || !LINE_RE.test(l)) continue;
    used += bytes(l) + 1;
    if (used > maxBytes) break;
    out.push(l);
  }
  return out.join('\n');
}

/** The part of the map relevant to `touches`, at most SLICE_MAX_BYTES. '' when unusable. */
export function sliceMap(mapText, touches) {
  if (typeof mapText !== 'string' || mapText === '') return '';
  const map = parseMap(mapText);
  if (!map) return '';
  const ts = (Array.isArray(touches) ? touches : []).map((t) => String(t).trim()).filter(Boolean);

  const units = [];
  const root = map.sections.find((s) => s.key === 'Root');
  if (root) units.push(`\n${trimSection(root, ROOT_SLICE_BYTES)}\n`);
  for (const s of map.sections) {
    if (!s.path || s.key === 'Root' || !valid(s.path)) continue;
    if (ts.some((t) => globsOverlap(`${s.path}/**`, t))) units.push(`\n${trimSection(s, Infinity)}\n`);
  }
  const notes = [];
  for (const it of map.noteItems) {
    if (notes.length >= SLICE_NOTES_MAX) break;
    if (!valid(it.glob)) continue;
    if (!(it.glob === '**' || ts.some((t) => globsOverlap(it.glob, t)))) continue;
    const text = sanitizeText(it.text).slice(0, NOTE_TEXT_MAX).trim();
    if (text === '') continue;
    notes.push(`- \`${it.glob}\` — ${text}\n`);
  }
  notes.forEach((n, i) => units.push(i === 0 ? `\nNotes:\n${n}` : n));

  const more = (k) => `… ${k} more sections in ${MAP_REL}\n`;
  const head = `${MAP_LABEL}\n`;
  const total = head + units.join('');
  if (bytes(total) <= SLICE_MAX_BYTES) return total.replace(/\n+$/, '');
  let out = head;
  let i = 0;
  for (; i < units.length; i++) {
    const remaining = units.length - i - 1;
    const cost = bytes(units[i]) + (remaining > 0 ? bytes(`\n${more(remaining)}`) : 0);
    if (bytes(out) + cost > SLICE_MAX_BYTES) break;
    out += units[i];
  }
  const k = units.length - i;
  if (k > 0) out += `\n${more(k)}`;
  return out.replace(/\n+$/, '');
}

// --- fs + git --------------------------------------------------------------------

/** {text} | {missing: true} | {unreadable: true}: only ENOENT counts as absent. */
function readMapState(root) {
  try {
    const file = path.join(root, MAP_REL);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > READ_MAX_BYTES * 4) return { unreadable: true };
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return err?.code === 'ENOENT' ? { missing: true } : { unreadable: true };
  }
}

/** Text of `<root>/.dev-cycle/map.md`, or null when absent or unreadable. */
export function readMapText(root) {
  return readMapState(root).text ?? null;
}

function makeReader(root) {
  return (rel) => {
    try {
      const file = path.join(root, rel);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > READ_MAX_BYTES) return null;
      return fs.readFileSync(file, 'utf8');
    } catch { return null; }
  };
}

async function headSha(root, env) {
  try {
    const r = await gitRun(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, env });
    const sha = r.stdout.trim();
    return r.code === 0 && HEAD_RE.test(sha) ? sha : null;
  } catch { return null; }
}

/** @returns {Promise<{files: string[]} | {tooLarge: true} | null>} null on git failure */
async function listFiles(root, env) {
  try {
    const r = await gitRun(['ls-files', '-z'], { cwd: root, env });
    if (r.code !== 0) return null;
    if (r.stdout.length >= OUTPUT_CAP) return { tooLarge: true };
    return { files: r.stdout.split('\0').filter(Boolean) };
  } catch { return null; }
}

/** Refresh `.dev-cycle/map.md` (R8). Never throws for a missing repo or git. */
export async function refreshMap(root, { env, force = false } = {}) {
  const skipped = { status: 'skipped', path: MAP_REL, head: null };
  const head = await headSha(root, env);
  if (!head) return skipped;
  const state = readMapState(root);
  const existingText = state.text ?? null;
  const existing = existingText === null ? null : parseMap(existingText);
  if (state.unreadable || (existingText !== null && !existing)) return { status: 'invalid', path: MAP_REL, head: null };
  if (existing && existing.head === head && !force) return { status: 'fresh', path: MAP_REL, head };

  const listed = await listFiles(root, env);
  if (!listed) return skipped;
  if (listed.tooLarge) return { status: 'too-large', path: MAP_REL, head: null };
  const body = buildMapBody({ files: listed.files, read: makeReader(root) });
  if (existing && existing.body === body) return { status: 'unchanged', path: MAP_REL, head: existing.head };

  fs.mkdirSync(path.join(root, '.dev-cycle'), { recursive: true });
  atomicWrite(path.join(root, MAP_REL), renderMap({ head, body, notes: existing ? existing.notes : undefined }));
  return { status: existing ? 'updated' : 'created', path: MAP_REL, head };
}

/** Read-only freshness check (R9). */
export async function checkMap(root, { env } = {}) {
  const head = await headSha(root, env);
  if (!head) return { fresh: false, reason: 'not a git repository' };
  const state = readMapState(root);
  if (state.missing) return { fresh: false, reason: 'missing' };
  const existing = state.unreadable ? null : parseMap(state.text);
  if (!existing) return { fresh: false, reason: 'invalid header' };
  const listed = await listFiles(root, env);
  if (!listed) return { fresh: false, reason: 'not a git repository' };
  if (listed.tooLarge) return { fresh: false, reason: 'too-large' };
  const body = buildMapBody({ files: listed.files, read: makeReader(root) });
  return body === existing.body ? { fresh: true, reason: null } : { fresh: false, reason: 'content differs' };
}
