// Pure helpers for the lessons memory file (.dev-cycle/lessons.md).
// No I/O here: cmd-lessons.mjs and brief.mjs import these.

import { globsOverlap } from './glob-overlap.mjs';

export const LESSONS_REL = '.dev-cycle/lessons.md';
export const LESSONS_HEADER = '# dev-cycle lessons';
export const LESSONS_COMMENT = '<!-- Advisory rules learned from reviews. One lesson per line; managed by `dev-cycle lessons`. -->';
export const MAX_TEXT = 240;

const LINE_RE = /^- \[L(\d+)\] (`[^`]+`(?:, `[^`]+`)*) — (.+) _\((\d{4}-\d{2}-\d{2}) · ([^\s·]+) · ([^\s·]+)\)_$/;

/**
 * Parse lessons text. Returns every raw line (unchanged) plus the parsed
 * lessons, each carrying its line index. Non-matching lines are only kept
 * in `lines`.
 * @param {string} text
 * @returns {{lines: string[], lessons: Array<{n:number,id:string,globs:string[],text:string,date:string,slug:string,ref:string,line:string,index:number}>, trailingNewline: boolean}}
 */
export function parseLessons(text) {
  const src = text ?? '';
  const trailingNewline = src.endsWith('\n');
  const lines = src === '' ? [] : (trailingNewline ? src.slice(0, -1) : src).split('\n');
  const lessons = [];
  lines.forEach((line, index) => {
    const m = LINE_RE.exec(line);
    if (!m) return;
    const rawGlobs = [...m[2].matchAll(/`([^`]+)`/g)].map((g) => g[1]);
    // Read-time sanitizing: a hand-edited line may carry invisible or control
    // characters that `lessons add` would have stripped; consumers render the
    // sanitized fields, and `invalid` lessons are never rendered.
    const text = sanitizeText(m[3]);
    const globs = rawGlobs.map(stripInvisible);
    const invalid = validateText(text) !== null || validateGlobs(globs.join(',')).error !== null
      || globs.some((g, i) => g !== rawGlobs[i]);
    lessons.push({
      n: Number(m[1]), id: `L${m[1]}`, globs, text, date: m[4], slug: stripInvisible(m[5]),
      ref: m[6] === '-' ? '' : stripInvisible(m[6]), line, index, invalid,
    });
  });
  return { lines, lessons, trailingNewline };
}

/** One lesson line (R13). `ref` empty -> `-`. */
export function formatLesson({ n, globs, text, date, slug, ref }) {
  return `- [L${n}] ${globs.map((g) => `\`${g}\``).join(', ')} — ${text} _(${date} · ${slug} · ${ref || '-'})_`;
}

/** Invisible / format characters (Unicode Cf: zero-width, bidi overrides, BOM, tag chars U+E0000–E007F). */
const INVISIBLE_RE = /[\p{Cf}\u{E0000}-\u{E007F}]/gu;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Remove invisible / format characters (no replacement). */
export function stripInvisible(raw) {
  return String(raw ?? '').replace(INVISIBLE_RE, '');
}

/**
 * Invisible/format chars removed, control chars -> one space, strip leading
 * '#' and surrounding whitespace. Returns '' when empty; throws nothing.
 */
export function sanitizeText(raw) {
  let s = stripInvisible(raw).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  s = s.trim().replace(/^#+/, '').trim();
  return s.replace(/\s+/g, ' ');
}

/** Validate a sanitized text length. Returns an error message or null. */
export function validateText(text) {
  if (text.length < 1) return 'lesson text is empty after sanitizing';
  if (text.length > MAX_TEXT) return `lesson text is ${text.length} chars (max ${MAX_TEXT})`;
  return null;
}

/**
 * Split a comma-separated glob list and validate it.
 * @returns {{globs: string[], error: string|null}}
 */
export function validateGlobs(raw) {
  const str = String(raw ?? '');
  if (CONTROL_RE.test(str) || new RegExp(INVISIBLE_RE.source, 'u').test(str)) {
    return { globs: [], error: `globs must not contain control or invisible characters: ${JSON.stringify(str)}` };
  }
  const globs = str.split(',').map((g) => g.trim());
  if (globs.length === 0 || globs.every((g) => g === '')) return { globs: [], error: 'globs are required' };
  for (const g of globs) {
    if (g === '') return { globs, error: 'empty glob in list' };
    if (g.includes('`')) return { globs, error: `glob must not contain a backtick: ${g}` };
    if (g === '*' || g === '**') return { globs, error: `glob too broad: ${g}` };
  }
  return { globs, error: null };
}

export function normalizeText(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** New array sorted by date desc, then id number desc. */
export function sortNewest(lessons) {
  return [...lessons].sort((a, b) => (a.date === b.date ? b.n - a.n : (a.date < b.date ? 1 : -1)));
}

/** Valid lessons where at least one glob overlaps at least one touches glob. */
export function filterByTouches(lessons, touches) {
  const t = (touches ?? []).filter(Boolean);
  return lessons.filter((l) => !l.invalid && l.globs.some((g) => t.some((x) => globsOverlap(g, x))));
}
