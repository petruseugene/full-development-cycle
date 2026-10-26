// dev-cycle polish init|defer|touches|list — polish-track batch (polish.md).
// Owner text is untrusted (L21): sanitized at write and again at every print.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, atomicWrite, output, parseCommandArgs, resolveFeatureDir, resolveProjectRoot, updateText } from './core.mjs';
import { validateAreas } from './cmd-feature.mjs';
import { readFeatureJson, updateFeatureJson } from './feature-json.mjs';
import { execOpts, gitRun } from './git-exec.mjs';
import { findTask, parsePlan } from './plan.mjs';
import { MAX_BASELINE, MAX_ITEMS, MAX_REASON, MAX_TITLE, POLISH_FILE, isDeferred, parseItems, readPolish, renderPolish,
  sanitizeItemText, validateTouch, wouldCut } from './polish.mjs';

const MAX_SCREEN = 60;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAGS = ['frontend', 'backend'];

function requirePolishTrack(fj) {
  if (fj.track !== 'polish') throw new UsageError(`polish: requires feature track polish (this feature is '${fj.track ?? '-'}')`);
}

function requireBatch(dir) {
  const p = readPolish(dir);
  if (!p) throw new UsageError(`file not found: ${path.join(dir, POLISH_FILE)} (run polish init first)`);
  return p;
}

function parseN(raw) {
  if (!/^\d+$/.test(raw ?? '')) throw new UsageError(`invalid item number '${raw}'`);
  return Number(raw);
}

function validateItems(raw) {
  if (!Array.isArray(raw)) throw new UsageError('polish init: items file must hold a JSON array');
  if (raw.length < 1 || raw.length > MAX_ITEMS) throw new UsageError(`polish init: expected 1..${MAX_ITEMS} items (got ${raw.length})`);
  const cuts = [];
  const items = raw.map((r, i) => {
    const id = `P${i + 1}`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new UsageError(`polish init: ${id} must be an object`);
    if (typeof r.title !== 'string') throw new UsageError(`polish init: ${id} title must be a string`);
    const title = sanitizeItemText(r.title, MAX_TITLE);
    if (title === '') throw new UsageError(`polish init: ${id} title is empty after sanitizing`);
    if (wouldCut(r.title, MAX_TITLE)) cuts.push(`polish: ${id} title cut to ${MAX_TITLE} chars\n`);
    if (typeof r.area !== 'string' || !KEBAB.test(r.area)) throw new UsageError(`polish init: ${id} area must be kebab-case`);
    if (!Array.isArray(r.touches) || r.touches.length === 0) throw new UsageError(`polish init: ${id} touches must be a non-empty string[]`);
    for (const t of r.touches) {
      const err = validateTouch(t);
      if (err) throw new UsageError(`polish init: ${id} ${err}`);
    }
    if (r.tag !== undefined && !TAGS.includes(r.tag)) throw new UsageError(`polish init: ${id} tag must be ${TAGS.join('|')}`);
    let screen = null;
    if (r.screen !== undefined && r.screen !== null) {
      if (typeof r.screen !== 'string') throw new UsageError(`polish init: ${id} screen must be a string`);
      screen = sanitizeItemText(r.screen, MAX_SCREEN) || null;
    }
    return { title, area: r.area, touches: [...new Set(r.touches)], tag: r.tag, screen };
  });
  return { items, cuts };
}

async function baseline(ctx, dir) {
  const root = resolveProjectRoot(ctx);
  let r;
  try { r = await gitRun(['ls-files', '--others', '--exclude-standard', '-z'], { ...execOpts(ctx), cwd: root }); } catch { r = null; }
  if (!r || r.code !== 0) {
    ctx.stderr.write('polish: git not available; untracked_baseline = []\n');
    return [];
  }
  const rel = path.relative(root, dir).split(path.sep).join('/');
  const prefix = rel && !rel.startsWith('..') ? `${rel}/` : null;
  const paths = r.stdout.split('\0').filter((p) => p !== '' && !(prefix && p.startsWith(prefix)));
  if (paths.length > MAX_BASELINE) ctx.stderr.write(`polish: untracked_baseline capped at ${MAX_BASELINE} paths\n`);
  return paths.slice(0, MAX_BASELINE);
}

async function init(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: 'polish init --items <file.json>',
    options: { items: { type: 'string', required: true } },
  });
  const dir = resolveFeatureDir(ctx, values);
  const fj = readFeatureJson(dir);
  requirePolishTrack(fj);
  if (fs.existsSync(path.join(dir, POLISH_FILE))) throw new UsageError(`polish init: ${POLISH_FILE} already exists`);
  let raw;
  const itemsFile = path.resolve(ctx.cwd, values.items);
  try { raw = JSON.parse(fs.readFileSync(itemsFile, 'utf8')); } catch (err) {
    throw new UsageError(`polish init: cannot read items file ${values.items}: ${err?.code === 'ENOENT' ? 'not found' : 'invalid JSON'}`);
  }
  const { items, cuts } = validateItems(raw);
  const defaultTag = fj.has_ui === true ? 'frontend' : 'backend';
  for (const it of items) it.tag ??= defaultTag;
  const areas = [];
  for (const it of items) {
    let a = areas.find((x) => x.name === it.area);
    if (!a) { a = { name: it.area, touches: [] }; areas.push(a); }
    for (const t of it.touches) if (!a.touches.includes(t)) a.touches.push(t);
  }
  const aerr = validateAreas(areas);
  if (aerr) throw new UsageError(`polish init: areas ${aerr}`);
  const untracked = await baseline(ctx, dir);
  for (const c of cuts) ctx.stderr.write(c);
  atomicWrite(path.join(dir, POLISH_FILE), renderPolish({ slug: fj.feature_slug, created: fj.created, items }), { expected: null });
  updateFeatureJson(dir, (f) => { f.areas = areas; f.untracked_baseline = untracked; });
  const msg = `polish: ${items.length} items in ${areas.length} areas`;
  output(ctx, values, { text: msg, data: { items: items.length, areas: areas.length } });
  return 0;
}

/** Index range [start, end) of the item's `### Task n` block. */
function blockRange(lines, item) {
  const start = item.headingIdx;
  if (start === undefined) throw new UsageError(`polish: P${item.n} has no '### Task ${item.n}' block in ${POLISH_FILE}`);
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) if (/^\s*#{1,4}\s+\S/.test(lines[j])) { end = j; break; }
  return [start, end];
}

function fieldIdx(lines, [start, end], name) {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\*\\*${name}:\\*\\*`, 'i');
  for (let i = start + 1; i < end; i++) if (re.test(lines[i])) return i;
  return -1;
}

/** Insert `line` after the last non-blank line of the block. */
function appendToBlock(lines, range, line) {
  let at = range[1];
  while (at > range[0] + 1 && lines[at - 1].replace(/\r$/, '').trim() === '') at--;
  const cr = lines[range[0]].endsWith('\r') ? '\r' : '';
  lines.splice(at, 0, `${line}${cr}`);
}

function setListTags(line, tags) {
  return line.replace(/^(\s*[-*]\s*\[[^\]]*\]\s*\*\*Task\s*\d+\*\*\s*)((?:\([^)]*\)\s*)*)(.*)$/is, (_, pre, groups, rest) => {
    const trail = /\s+$/.exec(groups)?.[0] ?? '';
    return `${pre}(${tags.join(', ')})${trail}${rest}`;
  });
}

async function defer(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: 'polish defer <n> --reason <text>',
    options: { reason: { type: 'string', required: true } },
    positionals: ['n'],
  });
  const dir = resolveFeatureDir(ctx, values);
  requirePolishTrack(readFeatureJson(dir));
  const n = parseN(args.n);
  const reason = sanitizeItemText(values.reason, MAX_REASON);
  if (reason === '') throw new UsageError('polish defer: --reason is empty after sanitizing');
  const { file, text } = requireBatch(dir);
  const raw = parsePlanTask(text, n);
  if (!raw) throw new UsageError(`polish defer: item P${n} not found`);
  if (raw.status === 'DONE') throw new UsageError(`polish defer: P${n} is already DONE`);
  updateText(file, (before) => {
    const task = parsePlanTask(before, n);
    const lines = before.split('\n');
    const tags = task.tag.split(/[\s,]+/).filter(Boolean);
    if (!tags.some((t) => t.toLowerCase() === 'deferred')) tags.push('deferred');
    if (task.listLineIdx >= 0) lines[task.listLineIdx] = setListTags(lines[task.listLineIdx], tags);
    const range = blockRange(lines, task);
    const idx = fieldIdx(lines, range, 'Deferred');
    const cr = lines[range[0]].endsWith('\r') ? '\r' : '';
    if (idx >= 0) lines[idx] = `**Deferred:** ${reason}${cr}`;
    else appendToBlock(lines, range, `**Deferred:** ${reason}`);
    return lines.join('\n');
  });
  output(ctx, values, { text: `polish: P${n} deferred — ${reason}`, data: { item: `P${n}`, deferred: reason } });
  return 0;
}

// parsePlan-level task (headingIdx/listLineIdx) for item n.
function parsePlanTask(text, n) { return findTask(parsePlan(text), n); }

async function touches(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: 'polish touches <n> --add <glob,..>',
    options: { add: { type: 'string', required: true } },
    positionals: ['n'],
  });
  const dir = resolveFeatureDir(ctx, values);
  const fj = readFeatureJson(dir);
  requirePolishTrack(fj);
  const n = parseN(args.n);
  const globs = values.add.split(',').map((g) => g.trim());
  for (const g of globs) {
    const err = validateTouch(g);
    if (err) throw new UsageError(`polish touches: ${err}`);
  }
  const { file, text } = requireBatch(dir);
  const item = parseItems(text).find((i) => i.n === n);
  if (!item) throw new UsageError(`polish touches: item P${n} not found`);
  const merged = [...new Set([...item.touches, ...globs])];
  updateText(file, (before) => {
    const task = parsePlanTask(before, n);
    const lines = before.split('\n');
    const range = blockRange(lines, task);
    const idx = fieldIdx(lines, range, 'Touches');
    const cr = lines[range[0]].endsWith('\r') ? '\r' : '';
    const line = `**Touches:** ${merged.map((t) => `\`${t}\``).join(', ')}${cr}`;
    if (idx >= 0) lines[idx] = line; else appendToBlock(lines, range, line.replace(/\r$/, ''));
    return lines.join('\n');
  });
  if (item.area) {
    updateFeatureJson(dir, (f) => {
      const areas = Array.isArray(f.areas) ? f.areas : [];
      let a = areas.find((x) => x?.name === item.area);
      if (!a) { a = { name: item.area, touches: [] }; areas.push(a); }
      a.touches = [...new Set([...(Array.isArray(a.touches) ? a.touches : []), ...globs])];
      f.areas = areas;
    });
  }
  output(ctx, values, { text: `polish: P${n} touches ${merged.join(', ')}`, data: { item: `P${n}`, touches: merged } });
  return 0;
}

async function list(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: 'polish list [--json]' });
  const dir = resolveFeatureDir(ctx, values);
  const p = readPolish(dir);
  const items = p ? p.items : [];
  const lines = items.map((it) => {
    const title = sanitizeItemText(it.title, MAX_TITLE);
    const area = it.area ? sanitizeItemText(it.area, 60) : '-';
    const tail = isDeferred(it) ? ` — deferred: ${sanitizeItemText(it.deferred, MAX_REASON)}` : '';
    return `P${it.n} [${it.status}] (${area}) ${title}${tail}`;
  });
  output(ctx, values, { text: lines.join('\n'), data: items });
  return 0;
}

export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  if (sub === 'init') return init(rest, ctx);
  if (sub === 'defer') return defer(rest, ctx);
  if (sub === 'touches') return touches(rest, ctx);
  if (sub === 'list') return list(rest, ctx);
  throw new UsageError(`unknown polish subcommand '${sub ?? ''}' (usage: dev-cycle polish init|defer|touches|list ...)`);
}
