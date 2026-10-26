// Polish track batch file (polish.md): render, parse and field helpers.
// polish.md reuses the parsePlan task grammar (L4: one list grammar); this
// module only adds the `**Item:**`, `**Area:**`, `**Screen:**` and
// `**Deferred:**` fields plus owner-text sanitizing (L21).
//
// Frozen API (the git area imports readPolish, parseItems, isDeferred,
// sanitizeItemText):
//   POLISH_FILE, MAX_ITEMS, MAX_TITLE, MAX_REASON, MAX_BASELINE
//   sanitizeItemText(raw, max) -> string
//   validateTouch(glob)        -> string|null
//   renderPolish({slug, created, items}) -> string
//   parseItems(text)           -> Item[]
//   isDeferred(item)           -> boolean
//   readPolish(dir)            -> {file, text, items} | null

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeText, validateGlobs } from './lessons.mjs';
import { hasTagToken, parsePlan } from './plan.mjs';

export const POLISH_FILE = 'polish.md';
export const MAX_ITEMS = 20;
export const MAX_TITLE = 100;
export const MAX_REASON = 200;
export const MAX_BASELINE = 5000;

/**
 * sanitizeText, then cut to `max` characters (the last one is '…' when cut).
 * @param {unknown} raw @param {number} max
 */
export function sanitizeItemText(raw, max) {
  const s = sanitizeText(raw);
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** True when sanitizing `raw` would cut it to fewer than its sanitized length. */
export function wouldCut(raw, max) {
  return Array.from(sanitizeText(raw)).length > max;
}

/**
 * Validate one item touch glob. Returns an error message or null.
 * @param {unknown} glob
 */
export function validateTouch(glob) {
  if (typeof glob !== 'string' || glob === '') return 'touch must be a non-empty string';
  if (glob.includes('\0')) return `touch must not contain NUL: ${JSON.stringify(glob)}`;
  if (glob.includes(',')) return `touch must not contain a comma: ${glob}`;
  const { error } = validateGlobs(glob);
  if (error) return error;
  if (glob.startsWith('/') || glob.startsWith('\\') || /^[A-Za-z]:/.test(glob)) return `touch must be relative: ${glob}`;
  if (glob.startsWith('-')) return `touch must not start with '-': ${glob}`;
  if (glob.split(/[\\/]+/).includes('..')) return `touch must not contain a '..' segment: ${glob}`;
  return null;
}

/**
 * Render polish.md.
 * @param {{slug: string, created: string,
 *   items: Array<{title: string, tag?: string, area: string, screen?: string|null, touches: string[]}>}} p
 */
export function renderPolish({ slug, created, items }) {
  const out = ['---', `feature: ${slug}`, `created: ${created}`, 'status: [TODO]', 'flow: feature', 'track: polish', '---', '',
    `# Polish batch — ${slug}`, '', '## Tasks'];
  const clean = items.map((it) => ({ ...it, title: sanitizeItemText(it.title, MAX_TITLE), tag: it.tag || 'frontend' }));
  clean.forEach((it, i) => out.push(`- [TODO] **Task ${i + 1}** (${it.tag}): ${it.title}`));
  clean.forEach((it, i) => {
    out.push('', `### Task ${i + 1}`, `**Item:** P${i + 1}`, `**Area:** ${it.area}`);
    const screen = it.screen ? sanitizeItemText(it.screen, 60) : '';
    if (screen) out.push(`**Screen:** ${screen}`);
    out.push(`**Touches:** ${it.touches.map((t) => `\`${t}\``).join(', ')}`);
  });
  return `${out.join('\n')}\n`;
}

function field(detail, name) {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\*\\*${name}:\\*\\*\\s*(.*)$`, 'i');
  for (const line of detail.split('\n')) {
    const m = line.replace(/\r$/, '').match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * parsePlan plus the Area / Screen / Deferred fields.
 * @param {string} text
 * @returns {Array<{n: number, id: string, title: string, tag: string, status: string, area: string|null,
 *   screen: string|null, touches: string[], deferred: string|null}>}
 */
export function parseItems(text) {
  return parsePlan(text).map((t) => {
    const detail = t.detailText ?? '';
    const area = field(detail, 'Area');
    const screen = field(detail, 'Screen');
    const deferred = field(detail, 'Deferred');
    return {
      n: t.n, id: `P${t.n}`, title: t.title, tag: t.tag, status: t.status,
      area: area || null, screen: screen || null, touches: t.touches,
      deferred: deferred ? deferred : null,
    };
  });
}

/** `deferred` tag token AND a non-empty reason. */
export function isDeferred(item) {
  return hasTagToken(item, 'deferred') && typeof item?.deferred === 'string' && item.deferred.trim() !== '';
}

/**
 * Read `<dir>/polish.md`. null when absent.
 * @param {string} dir feature folder
 */
export function readPolish(dir) {
  const file = path.join(dir, POLISH_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
  return { file, text, items: parseItems(text) };
}
