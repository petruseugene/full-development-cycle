// Shared AC index for spec.md (spec R1-R5). Pure: takes text, returns data, no file I/O.
//
//   parseSpecAcs(text) -> { acs, duplicates, unscoped, markerErrors, maxId }
//   resolveAc(acs, n)  -> { live, chain }
//   parseAcIds(raw)    -> number[]   (ids of an `**Acceptance:**` value)

import { UsageError } from './core.mjs';

export const AC_LINE_RE = /^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?\**AC(\d+)\**\s*(?:\([^)]*\)\s*)?[:.)\-–—]/;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const SUPERSEDE_BRACKET_RE = /\[\s*(?:superseded|замен[её]н)[^\]]*\]/i;
const SUPERSEDE_TARGETS_RE = /(?:→|->)\s*(AC\s*\d+(?:\s*(?:,|and|и)\s*AC\s*\d+)*)/i;
const REMOVED_RE = /\(\s*removed\s*[—–-]\s*D\d+\s*\)/i;

/** AC numbers referenced by an `**Acceptance:**` value, ranges expanded. */
export function parseAcIds(raw) {
  const ids = [];
  for (const m of raw.matchAll(/\bAC\s*(\d+)(?:\s*[–-]\s*(?:AC\s*)?(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a) throw new UsageError(`invalid AC range AC${a}-AC${b}`);
    for (let i = a; i <= b; i++) if (!ids.includes(i)) ids.push(i);
  }
  return ids;
}

/** Marker info for the first line of an AC block. */
function parseMarkers(firstLine, prefixLen) {
  const rest = firstLine.slice(prefixLen);
  const removed = REMOVED_RE.test(rest);
  let superseded = null;
  let error = null;
  const br = SUPERSEDE_BRACKET_RE.exec(rest);
  if (br) {
    const t = SUPERSEDE_TARGETS_RE.exec(br[0]);
    if (t) {
      const by = [];
      for (const m of t[1].matchAll(/AC\s*(\d+)/gi)) {
        const n = Number(m[1]);
        if (!by.includes(n)) by.push(n);
      }
      superseded = { by };
    } else {
      error = `superseded marker without a parsable target: ${br[0]}`;
    }
  }
  return { removed, superseded: removed ? null : superseded, error };
}

/**
 * Index every AC definition in spec.md.
 * @param {string} text
 */
export function parseSpecAcs(text) {
  const acs = new Map();
  const duplicates = [];
  const unscoped = [];
  const markerErrors = [];
  let maxId = 0;
  const bump = (n) => { if (n > maxId) maxId = n; };

  let fence = null; // fence char while inside a fenced block
  let fenceLen = 0;
  let scopeLevel = 0; // 0 = not in an AC scope
  let cur = null; // {n, line, lines, dup}

  const flush = () => {
    if (!cur) return;
    if (cur.skip) { cur = null; return; }
    const block = cur.lines.join('\n').replace(/\s+$/, '');
    if (cur.dup) {
      const d = duplicates.find((x) => x.n === cur.n);
      if (d) d.lines.push(cur.line);
    } else {
      const { removed, superseded, error } = parseMarkers(cur.lines[0], cur.prefixLen);
      acs.set(cur.n, { n: cur.n, text: block, line: cur.line, superseded, removed });
      if (error) markerErrors.push({ n: cur.n, line: cur.line, problem: error });
    }
    cur = null;
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const fm = /^\s*(```+|~~~+)/.exec(line);
    if (fm) {
      if (fence === null) { fence = fm[1][0]; fenceLen = fm[1].length; }
      else if (fm[1][0] === fence && fm[1].length >= fenceLen) fence = null;
      if (cur) cur.lines.push(line);
      continue;
    }
    if (fence !== null) { if (cur) cur.lines.push(line); continue; }

    const hm = HEADING_RE.exec(line);
    if (hm) {
      const level = hm[1].length;
      if (scopeLevel > 0 && level <= scopeLevel) { flush(); scopeLevel = 0; }
      else if (scopeLevel > 0) flush();
      if (scopeLevel === 0 && /acceptance criteria/i.test(hm[2])) scopeLevel = level;
      continue;
    }

    const m = AC_LINE_RE.exec(line);
    if (m) {
      const n = Number(m[1]);
      bump(n);
      if (scopeLevel === 0) { unscoped.push({ n, line: i + 1 }); continue; }
      flush();
      // Legacy sub-numbered ids (`AC1.1`) read as AC<n> but never count as a duplicate of it:
      // they still end the previous block, and are indexed only when AC<n> is not defined yet.
      const sub = m[0].endsWith('.') && /^\d/.test(line.slice(m[0].length));
      const skip = sub && acs.has(n);
      const dup = !sub && (acs.has(n) || duplicates.some((d) => d.n === n) || (cur && cur.n === n));
      if (dup && !duplicates.some((d) => d.n === n)) duplicates.push({ n, lines: [acs.get(n)?.line ?? i + 1] });
      cur = { n, line: i + 1, lines: [line], dup, skip, prefixLen: m[0].length };
    } else if (cur) {
      cur.lines.push(line); // blank lines and paragraphs stay inside the AC
    }
  }
  flush();
  return { acs, duplicates, unscoped, markerErrors, maxId };
}

/**
 * Follow supersede links to the live ACs. Removed ACs resolve to themselves.
 * @param {Map<number, {superseded: {by:number[]}|null}>} acs
 * @param {number} n
 * @returns {{live:number[], chain:number[]}}
 */
export function resolveAc(acs, n) {
  const live = [];
  const chain = [];
  const stack = [];
  const visit = (id) => {
    const ac = acs.get(id);
    if (!ac) throw new UsageError(`AC${id} is not defined in spec.md`);
    if (stack.includes(id)) throw new UsageError(`supersede cycle: ${[...stack, id].map((x) => `AC${x}`).join(' → ')}`);
    if (!chain.includes(id)) chain.push(id);
    if (!ac.superseded || ac.removed) {
      if (!live.includes(id)) live.push(id);
      return;
    }
    stack.push(id);
    for (const t of ac.superseded.by) visit(t);
    stack.pop();
  };
  visit(n);
  return { live, chain };
}
