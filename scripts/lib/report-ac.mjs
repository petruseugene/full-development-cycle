// AC coverage parser and AC map model for the report command. Pure: takes
// already-read text, never reads files, never throws on malformed input.
//
//   parseAcCoverage(reportText) -> { entries, source, hasBullets }
//   buildAcMap({ specText, planText, reportText }) -> { ac_map, counts }

import { indexSpecAcs, parseAcIds } from './brief.mjs';
import { parsePlan } from './plan.mjs';

export const AC_CLASSES = Object.freeze(['failing', 'auto', 'visual', 'manual', 'none', 'unknown']);
const AC_TEXT_MAX = 160;
const MAX_RANGE = 500;

const SECTION_RE = /^#{2}\s+AC coverage(?:\s*[—–-]\s*(auto|visual))?\s*$/i;
const BULLET_RE = /^\s*[-*]\s*\[([A-Za-z][\w-]*)\]\s*(.*)$/;
const ID_ITEM = String.raw`AC\s*\d+(?:\s*[–-]\s*(?:AC\s*)?\d+)?`;
const IDS_RE = new RegExp(String.raw`^(${ID_ITEM}(?:\s*(?:,|&|and)\s*${ID_ITEM})*)\s*(.*)$`, 'i');

/** @param {string} raw @returns {number[]|null} */
function safeIds(raw) {
  for (const m of raw.matchAll(/\bAC\s*(\d+)\s*[–-]\s*(?:AC\s*)?(\d+)/gi)) {
    if (Number(m[2]) - Number(m[1]) > MAX_RANGE) return null;
  }
  try { return parseAcIds(raw.toUpperCase()); } catch { return null; }
}

/** One bullet line -> {status, ids, evidence} or null when malformed. */
function parseBullet(line) {
  const b = BULLET_RE.exec(line);
  if (!b) return null;
  const m = IDS_RE.exec(b[2].trim());
  if (!m) return null;
  const tail = m[2].trim();
  let evidence = '';
  if (tail) {
    const sep = /^[—–:-]\s*(.*)$/.exec(tail);
    if (!sep) return null; // "AC1 junk" / "AC1x" -> malformed
    evidence = sep[1].trim();
  }
  const ids = safeIds(m[1]);
  if (!ids || ids.length === 0) return null;
  return { status: b[1].toLowerCase(), ids, evidence };
}

/**
 * Parse AC coverage bullets from a test report.
 * Sections `## AC coverage[ — auto| — visual]` (no suffix = auto) are read; with
 * none present, any `- [status] AC…` bullet counts, with source `legacy`.
 * @param {string} reportText
 * @returns {{entries: {status: string, ac: number, source: 'auto'|'visual'|'legacy', evidence: string}[], hasBullets: boolean}}
 */
export function parseAcCoverage(reportText) {
  const entries = [];
  try {
    const lines = String(reportText ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
    const sectionLines = [];
    let sawSection = false;
    let cur = null;
    for (const line of lines) {
      if (/^#{1,2}\s/.test(line)) {
        const m = SECTION_RE.exec(line.trim());
        cur = m ? (m[1] || 'auto').toLowerCase() : null;
        if (m) sawSection = true;
        continue;
      }
      if (cur) sectionLines.push([cur, line]);
    }
    const pairs = sawSection ? sectionLines : lines.map((l) => ['legacy', l]);
    for (const [source, line] of pairs) {
      const e = parseBullet(line);
      if (!e) continue;
      for (const ac of e.ids) entries.push({ status: e.status, ac, source, evidence: e.evidence });
    }
  } catch { /* never throws */ }
  return { entries, hasBullets: entries.length > 0 };
}

function classify(rowEntries, hasBullets) {
  if (!hasBullets) return 'unknown';
  const has = (pred) => rowEntries.some(pred);
  if (has((e) => e.status === 'fail' || e.status === 'failed')) return 'failing';
  if (has((e) => e.status === 'pass' && (e.source === 'auto' || e.source === 'legacy'))) return 'auto';
  if (has((e) => e.status === 'pass' && e.source === 'visual')) return 'visual';
  if (has((e) => e.status === 'manual')) return 'manual';
  return 'none';
}

/**
 * @param {{specText?: string, planText?: string, reportText?: string}} input
 * @returns {{ac_map: {ac: number, text: string, tasks: number[], task: number|null, class: string, source: string|null, evidence: string|null}[], counts: Record<string, number>}}
 */
export function buildAcMap({ specText = '', planText = '', reportText = '' } = {}) {
  const counts = Object.fromEntries(AC_CLASSES.map((c) => [c, 0]));
  const ac_map = [];
  try {
    const index = indexSpecAcs(String(specText ?? ''));
    const taskOf = new Map();
    if (planText) {
      let tasks = [];
      try { tasks = parsePlan(String(planText)); } catch { /* no plan */ }
      for (const t of tasks) {
        let ids = [];
        try { ids = parseAcIds(t.acceptanceRaw ?? ''); } catch { /* skip bad range */ }
        for (const id of ids) {
          if (!taskOf.has(id)) taskOf.set(id, []);
          taskOf.get(id).push(t.n);
        }
      }
    }
    const { entries, hasBullets } = parseAcCoverage(reportText);
    for (const n of [...index.keys()].sort((a, b) => a - b)) {
      const raw = index.get(n);
      const text = raw.replace(/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?\**AC\d+\**\s*(?:\([^)]*\)\s*)?[:.)\-–—]\s*/, '')
        .replace(/\s+/g, ' ').trim().slice(0, AC_TEXT_MAX);
      const mine = entries.filter((e) => e.ac === n);
      const cls = classify(mine, hasBullets);
      const pick = mine.find((e) => (cls === 'failing' ? /^fail/.test(e.status) : cls === 'manual' ? e.status === 'manual' : e.status === 'pass')) ?? null;
      const tasks = taskOf.get(n) ?? [];
      counts[cls]++;
      ac_map.push({ ac: n, text, tasks, task: tasks[0] ?? null, class: cls, source: pick?.source ?? null, evidence: pick?.evidence || null });
    }
  } catch { /* never throws */ }
  return { ac_map, counts };
}
