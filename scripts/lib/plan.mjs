// Tolerant plan.md reader + minimal-diff status writer.
//
// API (pure functions over text, except tasksSource which reads files):
//   tasksSource(dir)           -> {file, text} | null   (plan.md, else spec.md with `## Tasks`)
//   hasTagToken(task, token)   -> boolean  (token among the task's tags; case-insensitive, no substring match)
//   isOwnerTask(task)          -> boolean  (`owner` token among the task's tags)
//   isContentTask(task)        -> boolean  (`content` token among the task's tags)
//   parsePlan(text)            -> Task[]   (sorted by plan order, one per task number)
//   findTask(tasks, n)         -> Task | undefined
//   normalizeStatus(raw)       -> 'TODO' | 'IN PROGRESS' | 'IMPL-DONE' | 'IN REVIEW' | 'BLOCKED' | 'DONE' | null
//   setTaskStatus(text, n, S)  -> text   (touches only task n's list line and heading status token)
//   setFrontmatterStatus(text, S) -> text | null   (first `status:` line in the first `---` block)
//   STATUSES
//
// Task shape:
//   { n, tag, status, title, listLineIdx, headingIdx?, detailText?, touches[],
//     dependsOn[], files[], wireframes[], acceptanceRaw, size, recipe }
//   - listLineIdx / headingIdx are 0-based indexes into text.split('\n');
//     listLineIdx is -1 when the task has no `## Tasks` list line, headingIdx
//     is absent when it has no `### Task N` heading.
//   - tag: lower-case; from the list line `(tag)`, else `**Tag:**`, else a
//     trailing `(tag)` on the heading; '' when unknown.
//   - status: normalised status from the list line (else the heading).
//   - detailText: the lines from the heading up to the next heading, or absent.
//   - dependsOn: task numbers ([] for `none…`); touches/files/wireframes: strings.
//   - recipe: trimmed value of `**Recipe:**` ('' when absent).
//   - acceptanceRaw / size: raw text of the field ('' when missing).
// Code fences are ignored. Line endings (CRLF) are preserved by the writers.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './core.mjs';

export const STATUSES = Object.freeze(['TODO', 'IN PROGRESS', 'IMPL-DONE', 'IN REVIEW', 'BLOCKED', 'DONE']);

/**
 * Normalise a status word. Accepts case-insensitive input with optional
 * brackets and `-`/`_`/space separators (`IN-PROGRESS` -> `IN PROGRESS`).
 * @param {string} raw
 * @returns {string|null} canonical status or null when unknown
 */
export function normalizeStatus(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^\[|\]$/g, '').trim().toUpperCase().replace(/[\s_-]+/g, ' ');
  if (s === 'IMPL DONE') return 'IMPL-DONE';
  return STATUSES.includes(s) ? s : null;
}

const STATUS_ALT = 'TODO|IN[ _-]PROGRESS|DOING|IN[ _-]TESTING|TESTING|IMPL[ _-]DONE|IN[ _-]REVIEW|BLOCKED|DONE';
const LIST_RE = new RegExp(`^(\\s*[-*]\\s*)\\[(${STATUS_ALT})\\](\\s*\\*\\*Task\\s*(\\d+)\\*\\*\\s*)((?:\\([^)]*\\)\\s*)*)[:\\-]?\\s*(.*)$`, 'i');
const HEAD_RE = /^\s*#{2,4}\s+Task\s+(\d+)\b(.*)$/i;
const HEAD_STATUS_RE = new RegExp(`\`?\\[(${STATUS_ALT})\\]\`?`, 'gi');
const ANY_HEADING_RE = /^\s*#{1,4}\s+\S/;

function legacyNormalize(raw) {
  const s = raw.toUpperCase().replace(/[\s_-]+/g, ' ');
  if (s === 'DOING') return 'IN PROGRESS';
  if (s === 'IN TESTING' || s === 'TESTING') return 'IN REVIEW';
  return normalizeStatus(raw);
}

function backticked(s) {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}

function listValues(s) {
  const ticks = backticked(s);
  if (ticks.length) return ticks;
  return s.split(',').map((x) => x.replace(/\(.*$/, '').trim()).filter(Boolean);
}

function parseDependsOn(value) {
  const v = value.replace(/[`*_]/g, '').trim();
  if (/^none\b/i.test(v) || v === '') return [];
  const m = v.match(/^Tasks?\s+\d+(?:\s*(?:,|;|and|&)\s*(?:Tasks?\s+)?\d+)*/i);
  return m ? [...m[0].matchAll(/\d+/g)].map((x) => Number(x[0])) : [];
}

/** Lines (0-based indexes) that are outside fenced code blocks. */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(true);
  let fence = null;
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      mask[i] = false;
    } else if (fence !== null) {
      mask[i] = false;
    }
  });
  return mask;
}

function fieldLine(lines, name) {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\*\\*${name}:\\*\\*\\s*(.*)$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].replace(/\r$/, '').match(re);
    if (m) return { idx: i, value: m[1].trim() };
  }
  return null;
}

/** Field value plus continuation bullet lines (for multi-line Files/Wireframes). */
function fieldBlock(lines, name) {
  const f = fieldLine(lines, name);
  if (!f) return '';
  const parts = [f.value];
  for (let i = f.idx + 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (!/^\s*[-*]\s/.test(l) || /^\s*[-*]\s*\*\*/.test(l)) break;
    parts.push(l);
  }
  return parts.join('\n');
}

/**
 * Parse plan.md into tasks. Never throws; missing pieces yield empty values.
 * @param {string} text
 * @returns {Array<{n:number, tag:string, status:string, title:string, listLineIdx:number,
 *   headingIdx?:number, detailText?:string, touches:string[], dependsOn:number[],
 *   files:string[], wireframes:string[], acceptanceRaw:string, size:string, recipe:string}>}
 */
export function parsePlan(text) {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  /** @type {Map<number, any>} */
  const byN = new Map();
  const get = (n) => {
    if (!byN.has(n)) {
      byN.set(n, { n, tag: '', status: 'TODO', title: '', listLineIdx: -1, touches: [], dependsOn: [],
        files: [], wireframes: [], acceptanceRaw: '', size: '', recipe: '' });
    }
    return byN.get(n);
  };
  const headingTags = new Map();
  const headings = [];

  lines.forEach((raw, i) => {
    if (!mask[i]) return;
    const line = raw.replace(/\r$/, '');
    const lm = line.match(LIST_RE);
    if (lm) {
      const t = get(Number(lm[4]));
      if (t.listLineIdx === -1) {
        t.listLineIdx = i;
        t.status = legacyNormalize(lm[2]) ?? 'TODO';
        t.tag = [...(lm[5] ?? '').matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).filter(Boolean).join(', ').toLowerCase();
        t.title = lm[6].trim();
        t.fromList = true;
      }
      return;
    }
    const hm = line.match(HEAD_RE);
    if (hm) {
      const n = Number(hm[1]);
      const t = get(n);
      if (t.headingIdx === undefined) {
        t.headingIdx = i;
        headings.push(i);
        let rest = hm[2];
        const all = [...rest.matchAll(HEAD_STATUS_RE)];
        const last = all[all.length - 1];
        let after = '';
        if (last) {
          after = rest.slice(last.index + last[0].length);
          rest = rest.slice(0, last.index);
          if (!t.fromList) t.status = legacyNormalize(last[1]) ?? 'TODO';
        }
        const tagM = (after.trim() ? after : rest).match(/\(([A-Za-z][\w-]*)\)\s*$/);
        if (tagM) {
          headingTags.set(n, tagM[1].toLowerCase());
          if (!last) rest = rest.slice(0, tagM.index);
        }
        if (!t.fromList) t.title = rest.replace(/^\s*[:\-—–]?\s*/, '').trim();
      }
    }
  });

  for (const t of byN.values()) {
    if (t.headingIdx !== undefined) {
      let end = lines.length;
      for (let j = t.headingIdx + 1; j < lines.length; j++) {
        if (mask[j] && ANY_HEADING_RE.test(lines[j]) && /^\s*#{1,3}\s/.test(lines[j])) { end = j; break; }
        if (mask[j] && HEAD_RE.test(lines[j])) { end = j; break; }
      }
      const detail = lines.slice(t.headingIdx + 1, end);
      t.detailText = detail.join('\n');
      const get1 = (name) => fieldLine(detail, name)?.value ?? '';
      if (!t.tag) {
        const tg = get1('Tag').replace(/[`*]/g, '').trim().toLowerCase();
        t.tag = tg || headingTags.get(t.n) || '';
      }
      t.touches = listValues(get1('Touches'));
      t.dependsOn = parseDependsOn(get1('Depends on'));
      t.files = backticked(fieldBlock(detail, 'Files'));
      const wf = fieldBlock(detail, 'Wireframes');
      t.wireframes = (backticked(wf).length ? backticked(wf) : wf.split(/[,\n]/).map((x) => x.replace(/^\s*[-*]\s*/, '').replace(/\s{2,}.*$/, '').trim())).filter(Boolean);
      t.acceptanceRaw = get1('Acceptance');
      t.recipe = get1('Recipe');
      t.size = get1('Size').replace(/[`*]/g, '').split(/\s+/)[0] ?? '';
    } else if (!t.tag) {
      t.tag = headingTags.get(t.n) || '';
    }
    delete t.fromList;
  }
  return [...byN.values()].sort((a, b) => {
    const ai = a.listLineIdx >= 0 ? a.listLineIdx : a.headingIdx;
    const bi = b.listLineIdx >= 0 ? b.listLineIdx : b.headingIdx;
    return ai - bi;
  });
}

/**
 * True when `token` (case-insensitive) is among the task's tags, split on
 * commas and whitespace, with wrapping brackets/backticks/`*`/`:` stripped.
 * `owner-ish` does not match `owner`; `contentful` does not match `content`.
 * @param {{tag?: string}} task @param {string} token
 */
export function hasTagToken(task, token) {
  const tag = typeof task?.tag === 'string' ? task.tag : '';
  const want = String(token).toLowerCase();
  return tag.split(/[\s,]+/).some((x) => x.replace(/^[(\[`*:]+|[)\]`*:]+$/g, '').toLowerCase() === want);
}

/** @param {{tag?: string}} task */
export function isOwnerTask(task) {
  return hasTagToken(task, 'owner');
}

/** @param {{tag?: string}} task */
export function isContentTask(task) {
  return hasTagToken(task, 'content');
}

/**
 * Resolve the feature's task list file (R38): plan.md when it exists, else
 * spec.md when it has a `## Tasks` line, else null.
 * @param {string} dir feature folder
 * @returns {{file: string, text: string} | null}
 */
export function tasksSource(dir) {
  const read = (f) => {
    try { return fs.readFileSync(f, 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
  };
  const planFile = path.join(dir, 'plan.md');
  const planText = read(planFile);
  if (planText !== null) return { file: planFile, text: planText };
  const specFile = path.join(dir, 'spec.md');
  const specText = read(specFile);
  if (specText !== null && /^##\s+Tasks\s*\r?$/m.test(specText)) return { file: specFile, text: specText };
  return null;
}

/**
 * tasksSource(dir), or a UsageError (exit 2) when there is none. The message
 * keeps the legacy `file not found: <dir>/plan.md` wording.
 * @param {string} dir
 * @returns {{file: string, text: string}}
 */
export function requireTasksSource(dir) {
  const src = tasksSource(dir);
  if (!src) throw new UsageError(`file not found: ${path.join(dir, 'plan.md')}`);
  return src;
}

/** @param {ReturnType<typeof parsePlan>} tasks @param {number} n */
export function findTask(tasks, n) {
  return tasks.find((t) => t.n === n);
}

/**
 * Return `text` with task n's status set to S. Only the status token in the
 * task's list line and in its `### Task n` heading change; every other byte
 * (including line endings and spacing) is preserved.
 * Throws UsageError for an unknown task or status.
 * @param {string} text @param {number} n @param {string} S
 * @param {{source?: string}} [opts] file name used in the not-found message
 */
export function setTaskStatus(text, n, S, { source = 'plan.md' } = {}) {
  const status = normalizeStatus(S);
  if (!status) throw new UsageError(`unknown status '${S}' (expected one of ${STATUSES.join(', ')})`);
  const task = findTask(parsePlan(text), n);
  if (!task) throw new UsageError(`task ${n} not found in ${source}`);
  const lines = text.split('\n');
  if (task.listLineIdx >= 0) {
    lines[task.listLineIdx] = lines[task.listLineIdx].replace(/\[[^\]]*\]/, `[${status}]`);
  }
  if (task.headingIdx !== undefined) {
    const h = lines[task.headingIdx];
    const all = [...h.matchAll(HEAD_STATUS_RE)];
    const last = all[all.length - 1];
    if (last) {
      const ticks = last[0].startsWith('`') ? '`' : '';
      lines[task.headingIdx] = h.slice(0, last.index) + `${ticks}[${status}]${last[0].endsWith('`') ? '`' : ''}` + h.slice(last.index + last[0].length);
    }
  }
  return lines.join('\n');
}

/**
 * Rewrite the first `status:` line inside the first `---` block to
 * `status: [S]`. Returns null when there is no such block/line.
 * @param {string} text @param {string} S canonical status
 * @returns {string|null}
 */
export function setFrontmatterStatus(text, S) {
  const status = normalizeStatus(S);
  if (!status) throw new UsageError(`unknown status '${S}' (expected one of ${STATUSES.join(', ')})`);
  const lines = text.split('\n');
  const isFence = (l) => l.replace(/\r$/, '').trimEnd() === '---';
  const open = lines.findIndex((l) => l.trim() !== '');
  if (open === -1 || !isFence(lines[open])) return null;
  for (let i = open + 1; i < lines.length; i++) {
    if (isFence(lines[i])) return null;
    const m = lines[i].match(/^(\s*status\s*:\s*)(.*?)(\r?)$/);
    if (m) {
      lines[i] = `${m[1]}[${status}]${m[3]}`;
      return lines.join('\n');
    }
  }
  return null;
}
