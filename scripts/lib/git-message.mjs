// Pure builders for `git commit` messages and `git pr` bodies (R16, R18).
// No I/O: callers pass spec text, parsed tasks and feature.json contents.

import { UsageError } from './core.mjs';
import { isOwnerTask } from './plan.mjs';

const TRAILER_RE = /^[A-Za-z][A-Za-z-]*: .+$/;
const PROBLEM_RE = /^##\s+(\d+\.\s*)?Problem\b/;

/** True when `s` is a valid single-line `Key: value` trailer (R16 step 4). */
export function validateTrailer(s) {
  return typeof s === 'string' && !/[\r\n]/.test(s) && TRAILER_RE.test(s);
}

/** First paragraph under the first `## Problem` heading, whitespace-joined; '' when absent. */
export function problemSummary(specText) {
  const lines = String(specText ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => PROBLEM_RE.test(l));
  if (start < 0) return '';
  const para = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) break;
    if (l.trim() === '') { if (para.length) break; continue; }
    para.push(l.trim());
  }
  return para.join(' ');
}

function specTitle(specText) {
  const m = String(specText ?? '').match(/^#\s+(.+?)\s*$/m);
  if (!m) return '';
  return m[1].replace(/\s+[—–-]\s+Spec\s*$/i, '').toLowerCase().replace(/[\s.,;:!?]+$/, '');
}

function topDir(touch) {
  const p = touch.replace(/[`*]/g, '').trim().replace(/^\.\//, '').replace(/^\/+/, '');
  const i = p.indexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

function deriveScope(fj, nonOwner) {
  const counts = new Map();
  for (const t of nonOwner) {
    for (const touch of t.touches ?? []) {
      const d = topDir(touch);
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (ranked.length) return ranked[0][0];
  return String(fj?.feature_slug ?? '').split('-')[0];
}

/** Closes values to `#n` lines. Accepts array or comma-separated string. */
function closesLines(closes) {
  const list = Array.isArray(closes) ? closes : String(closes ?? '').split(',');
  return list.map((c) => String(c).trim().replace(/^#/, '')).filter(Boolean).map((n) => {
    if (!/^\d+$/.test(n)) throw new UsageError(`invalid --closes value '${n}'`);
    return `Closes #${n}`;
  });
}

/**
 * Build the commit message (R16 steps 2-4). Ends with a single newline.
 * @param {{fj:any, specText?:string, tasks?:any[], folder?:string, scope?:string,
 *   subject?:string, body?:string, closes?:string|string[], trailers?:string[]}} o
 */
export function buildCommitMessage({ fj, specText = '', tasks = [], folder = '', scope, subject, body, closes, trailers = [] }) {
  for (const t of trailers) {
    if (!validateTrailer(t)) throw new UsageError(`invalid --trailer '${t}' (expected "Key: value" on one line)`);
  }
  const closeLines = closesLines(closes);
  const needsSubject = fj?.flow === 'bugfix' || fj?.flow === 'hotfix' || fj?.track === 'quick';
  const hasSubject = typeof subject === 'string' && subject.trim() !== '';
  if (needsSubject && !hasSubject) throw new UsageError('--subject is required for bugfix, hotfix and quick-track commits');

  const blocks = [];
  if (hasSubject) {
    blocks.push(subject.trim());
    if (typeof body === 'string' && body.trim()) blocks.push(body.trim());
    if (closeLines.length) blocks.push(closeLines.join('\n'));
  } else {
    const nonOwner = tasks.filter((t) => !isOwnerTask(t));
    const sc = scope || deriveScope(fj, nonOwner);
    blocks.push(`feat(${sc}): ${specTitle(specText)}`);
    const summary = problemSummary(specText);
    if (summary) blocks.push(summary);
    if (typeof body === 'string' && body.trim()) blocks.push(body.trim());
    if (nonOwner.length) blocks.push(['Tasks:', ...nonOwner.map((t) => `- Task ${t.n}: ${t.title}`)].join('\n'));
    blocks.push([`Refs: docs/features/${folder}/spec.md`, ...closeLines].join('\n'));
  }
  if (trailers.length) blocks.push(trailers.join('\n'));
  return blocks.join('\n\n') + '\n';
}

function lastEntry(history, phases) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) if (phases.includes(list[i]?.phase)) return list[i];
  return null;
}

function fmt(e) {
  if (!e) return null;
  return e.summary ? `${e.status} — ${e.summary}` : String(e.status);
}

/**
 * Build the PR body (R18).
 * @param {{specText?:string, tasks?:any[], history?:any[], headMessage?:string, footer?:string}} o
 */
export function buildPrBody({ specText = '', tasks = [], history = [], headMessage = '', footer = '' }) {
  const blocks = [];
  const summary = problemSummary(specText);
  if (summary) blocks.push(summary);
  const nonOwner = tasks.filter((t) => !isOwnerTask(t));
  if (nonOwner.length) blocks.push(['Tasks:', ...nonOwner.map((t) => `- Task ${t.n}: ${t.title}`)].join('\n'));
  blocks.push(`Tests: ${fmt(lastEntry(history, ['auto-test', 'visual-test'])) ?? 'not run'}`);
  const rev = fmt(lastEntry(history, ['review']));
  const sec = fmt(lastEntry(history, ['security']));
  blocks.push([`Review: ${rev ?? 'not run'}`, `Security: ${sec ?? 'not run'}`].join('\n'));
  const closes = [...String(headMessage).matchAll(/^Closes #(\d+)\s*$/gm)].map((m) => `Closes #${m[1]}`);
  if (closes.length) blocks.push(closes.join('\n'));
  if (footer) blocks.push(String(footer));
  return blocks.join('\n\n') + '\n';
}
