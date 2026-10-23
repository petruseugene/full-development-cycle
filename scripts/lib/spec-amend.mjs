// Pure text edits for `spec amend` (spec R13-R15). No file I/O.

import { UsageError } from './core.mjs';
import { AC_LINE_RE, parseSpecAcs } from './spec-acs.mjs';

const AC = (n) => `AC${n}`;

/** Local date as YYYY-MM-DD. */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function validateTitle(title) {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t === '') throw new UsageError('--title must not be empty');
  if (/[\x00-\x1f\x7f]/.test(t)) throw new UsageError('--title must not contain a newline or control characters');
  if (t.startsWith('#')) throw new UsageError("--title must not start with '#'");
  return t;
}

export function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError('--date must be YYYY-MM-DD');
  return date;
}

/** Indexes of lines outside fenced blocks. */
function outsideFences(lines) {
  const out = new Array(lines.length).fill(true);
  let fence = null;
  let len = 0;
  lines.forEach((line, i) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (m) {
      if (fence === null) { fence = m[1][0]; len = m[1].length; }
      else if (m[1][0] === fence && m[1].length >= len) fence = null;
      out[i] = false;
    } else if (fence !== null) out[i] = false;
  });
  return out;
}

/**
 * Insert the amendment heading pair.
 * @returns {{text: string, heading: string, nextAc: number, inserted: boolean}}
 */
export function insertAmendment(specText, { title, date }) {
  const heading = `## Amendment ${date} — ${title}`;
  const nextAc = parseSpecAcs(specText).maxId + 1;
  const lines = specText.split('\n');
  const out = outsideFences(lines);
  if (lines.some((l, i) => out[i] && l.replace(/\s+$/, '') === heading)) {
    return { text: specText, heading, nextAc, inserted: false };
  }
  const block = `${heading}\n\n### Acceptance Criteria (amendment ${date})\n\n`;
  const at = lines.findIndex((l, i) => out[i] && /^##\s+(?:Tasks\s*$|Area\s)/.test(l.replace(/\r$/, '')));
  let text;
  if (at >= 0) {
    const prevBlank = at === 0 || lines[at - 1].trim() === '';
    lines.splice(at, 0, ...(prevBlank ? [] : ['']), heading, '', `### Acceptance Criteria (amendment ${date})`, '');
    text = lines.join('\n');
  } else {
    const base = specText.endsWith('\n') ? specText : `${specText}\n`;
    text = `${base}\n${block.replace(/\n\n$/, '\n')}`;
  }
  return { text, heading, nextAc, inserted: true };
}

/** Parse `AC57=AC82[,AC83]` into {x, by}. */
export function parseSupersedeArg(raw) {
  const m = /^\s*AC(\d+)\s*=\s*(AC\d+(?:\s*,\s*AC\d+)*)\s*$/i.exec(raw);
  if (!m) throw new UsageError(`--supersede expects AC<x>=AC<y>[,AC<z>], got '${raw}'`);
  const by = [...m[2].matchAll(/AC(\d+)/gi)].map((x) => Number(x[1]));
  return { x: Number(m[1]), by: [...new Set(by)] };
}

/**
 * Apply all supersede pairs or throw (nothing partially applied).
 * @param {string} specText
 * @param {{x:number, by:number[]}[]} pairs
 */
export function applySupersede(specText, pairs) {
  const { acs } = parseSpecAcs(specText);
  const edges = new Map();
  for (const ac of acs.values()) if (ac.superseded) edges.set(ac.n, ac.superseded.by);
  const seenX = new Set();
  for (const { x, by } of pairs) {
    const src = acs.get(x);
    if (!src) throw new UsageError(`${AC(x)} is not defined in spec.md`);
    if (src.removed) throw new UsageError(`${AC(x)} is removed and cannot be superseded`);
    if (src.superseded || seenX.has(x)) throw new UsageError(`${AC(x)} is already superseded`);
    seenX.add(x);
    for (const t of by) {
      const tg = acs.get(t);
      if (t === x) throw new UsageError(`${AC(x)} cannot supersede itself`);
      if (!tg) throw new UsageError(`target ${AC(t)} is not defined in spec.md`);
      if (tg.removed) throw new UsageError(`target ${AC(t)} is removed`);
    }
    edges.set(x, by);
  }
  const reaches = (from, goal, seen = new Set()) => {
    if (from === goal) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (edges.get(from) ?? []).some((t) => reaches(t, goal, seen));
  };
  for (const { x, by } of pairs) {
    for (const t of by) {
      if (reaches(t, x)) throw new UsageError(`superseding ${AC(x)} by ${AC(t)} would create a cycle`);
    }
  }
  const lines = specText.split('\n');
  for (const { x, by } of pairs) {
    const idx = acs.get(x).line - 1;
    const m = AC_LINE_RE.exec(lines[idx]);
    const rest = lines[idx].slice(m[0].length);
    const marker = ` **[superseded → ${by.map(AC).join(', ')}]**`;
    lines[idx] = m[0] + marker + (rest === '' || /^\s/.test(rest) ? rest : ` ${rest}`);
  }
  return lines.join('\n');
}
