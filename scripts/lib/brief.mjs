// Task brief builder (spec R16). Pure: takes already-read inputs, returns text.
//
//   buildBrief({ task, specText, fj }) -> string
//
// Throws UsageError (exit 2) when an AC id referenced by the task cannot be
// resolved from spec.md. Never reads any file itself.

import { UsageError } from './core.mjs';
import { globsOverlap } from './glob-overlap.mjs';
import { filterByTouches, sanitizeText, sortNewest } from './lessons.mjs';
import { isContentTask } from './plan.mjs';
import { SKILL_ALIASES, isAlias } from './profile.mjs';
import { parseAcIds, parseSpecAcs, resolveAc } from './spec-acs.mjs';

/** Longest run of consecutive backticks in `s`. */
function longestBacktickRun(s) {
  return Math.max(0, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length));
}

/** Markdown code span that survives backticks inside `s`. */
export function codeSpan(s) {
  const str = String(s);
  const ticks = '`'.repeat(longestBacktickRun(str) + 1);
  const pad = str.startsWith('`') || str.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${str}${pad}${ticks}`;
}

/** Escape a GFM table cell: `|` → `\|` (also inside code spans), newlines → space. */
export function tableCell(s) {
  return String(s).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
}

/**
 * AC lines (with continuation lines) from every acceptance-criteria section of
 * spec.md, at any heading level (see spec-acs.mjs).
 * @param {string} specText
 * @returns {Map<number, string>}
 */
export function indexSpecAcs(specText) {
  const out = new Map();
  for (const [n, ac] of parseSpecAcs(specText).acs) out.set(n, ac.text);
  return out;
}

export { parseAcIds };

function dependencySummary(fj, d) {
  const hist = Array.isArray(fj.history) ? fj.history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i]?.phase === `implement.task=${d}`) {
      const s = hist[i].summary;
      return typeof s === 'string' && s.trim() ? s.trim() : '(no summary recorded)';
    }
  }
  return '(no summary recorded)';
}

const MODEL_VALUES = ['haiku', 'sonnet', 'opus', 'inherit'];
/** Implementer skill for a task tag: frontend/mixed -> frontend-dev, else backend-dev. */
function implementerOf(task, fj) {
  const tag = task.tag ?? '';
  if (/\bfrontend\b/.test(tag)) return 'frontend-dev';
  return /\bmixed\b/.test(tag) && !fj?.skipped_skills?.includes('frontend-dev') ? 'frontend-dev' : 'backend-dev';
}
/** `fj.models[skill]`, falling back to legacy alias keys that resolve to that owner. */
function modelOverride(models, skill) {
  if (!models) return undefined;
  if (MODEL_VALUES.includes(models[skill])) return models[skill];
  const legacy = Object.keys(models).find((k) => isAlias(k) && SKILL_ALIASES[k] === skill && MODEL_VALUES.includes(models[k]));
  return legacy ? models[legacy] : undefined;
}
/** Doc task: Size S and every Touches glob is markdown (R14). */
function isDocTask(task) {
  return task.size === 'S' && task.touches.length > 0
    && task.touches.every((g) => g.endsWith('.md') || g.startsWith('docs/'));
}
/** `<value> (<reason>)` for the task's implementer (R14/R15). */
export function modelLine(task, fj) {
  const override = modelOverride(fj?.models, implementerOf(task, fj));
  if (MODEL_VALUES.includes(override)) return `${override} (override)`;
  if (isDocTask(task)) return 'haiku (doc task)';
  return 'sonnet (default)';
}

/** `## Threat notes` section of spec.md, verbatim up to the next `##` heading; '' when absent. */
export function threatNotes(specText) {
  const lines = specText.split('\n');
  let fence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence || !/^#{1,2}\s/.test(lines[i])) continue;
    if (start >= 0) { end = i; break; }
    if (/^##\s+Threat notes\s*$/i.test(lines[i].replace(/\r$/, ''))) start = i;
  }
  return start < 0 ? '' : lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

export const TEST_BUDGET_LINE = 'Test budget: 1 happy-path + at most 2 error-path tests per AC.';

/** `## TDD` section (only when fj.tdd === true): live AC ids, probe, project test command, budget, evidence. */
function tddSection(task, specText, fj) {
  const { acs } = parseSpecAcs(specText);
  const live = [];
  for (const n of parseAcIds(task.acceptanceRaw ?? '')) {
    let ids = [n];
    try { ids = resolveAc(acs, n).live; } catch (e) { if (!(e instanceof UsageError)) throw e; }
    for (const l of ids) if (!live.includes(l)) live.push(l);
  }
  const sec = ['## TDD', ''];
  sec.push(`Owned ACs: ${live.length ? live.map((n) => `AC${n}`).join(', ') : '(none listed)'} — write one failing test per AC first (RED), then the minimal code (GREEN), then refactor.`, '');
  sec.push('Probe: `node <CLI> check --scope touched --files <test files> --steps test` — RED = exit 1 with a failure in the new test file, GREEN = exit 0.', '');
  const cmd = fj?.profile?.commands?.test;
  if (typeof cmd === 'string' && cmd !== '') {
    sec.push(`Project test command: ${codeSpan(cmd)} (for information; a \`{files}\` placeholder scopes the run to the touched tests).`, '');
  }
  sec.push(TEST_BUDGET_LINE, '');
  sec.push('Evidence: end `summary:` with `TDD <g>/<n> AC red→green` and add `tdd: {red: [...], green: [...], tests: [...], skipped: [...]}` to the report.', '');
  return sec;
}

export function buildBrief({ task, specText, fj, lessons = [] }) {
  const out = [];
  out.push(`# Brief: Task ${task.n}${task.title ? ` — ${task.title}` : ''}`, '');

  out.push(`**Model:** ${modelLine(task, fj)}`, '');

  out.push('## Task', '');
  out.push((task.detailText ?? '').replace(/\s+$/, '') || '(no detail section)', '');

  out.push('## Acceptance criteria', '');
  const ids = parseAcIds(task.acceptanceRaw ?? '');
  if (ids.length === 0) {
    out.push(task.acceptanceRaw ? task.acceptanceRaw : '(none listed)', '');
  } else {
    const { acs } = parseSpecAcs(specText);
    const resolved = new Map();
    const missing = [];
    for (const n of ids) {
      try { resolved.set(n, resolveAc(acs, n)); } catch (e) {
        if (!(e instanceof UsageError)) throw e;
        missing.push(n);
      }
    }
    if (missing.length) {
      throw new UsageError(`task ${task.n}: cannot resolve ${missing.map((n) => `AC${n}`).join(', ')} in spec.md`);
    }
    const printed = new Set();
    const block = (n) => {
      if (printed.has(n)) return;
      printed.add(n);
      out.push(acs.get(n).text);
    };
    for (const n of ids) {
      const { live } = resolved.get(n);
      if (live.length === 1 && live[0] === n) { block(n); continue; }
      if (!printed.has(`note${n}`)) {
        printed.add(`note${n}`);
        out.push(`> AC${n} superseded → ${live.map((x) => `AC${x}`).join(', ')} (resolved)`);
      }
      for (const l of live) block(l);
    }
    out.push('');
  }

  if (fj?.tdd === true) out.push(...tddSection(task, specText, fj));

  out.push('## Touches', '');
  out.push(...(task.touches.length ? task.touches.map((t) => `- \`${t}\``) : ['(none)']), '');

  out.push('## Depends on', '');
  out.push(...(task.dependsOn.length
    ? task.dependsOn.map((d) => `- Task ${d}: ${dependencySummary(fj, d)}`)
    : ['(none)']), '');

  out.push('## Project rules', '');
  const profile = fj.profile && typeof fj.profile === 'object' ? fj.profile : {};
  const guards = Array.isArray(profile.guards) ? profile.guards : [];
  const rules = (Array.isArray(profile.rules) ? profile.rules : [])
    .filter((r) => Array.isArray(r?.globs) && r.globs.some((g) => task.touches.some((t) => globsOverlap(g, t))));
  const items = [...guards.map((g) => `- ${g}`), ...rules.map((r) => `- ${r.text}`)];
  out.push(...(items.length ? items : ['(none)']), '');

  if (isContentTask(task)) {
    const recipes = Array.isArray(profile.recipes) ? profile.recipes : [];
    const rec = recipes.find((r) => r?.name === task.recipe);
    if (!task.recipe || !rec) {
      throw new UsageError(`brief: task ${task.n} is a content task but recipe '${task.recipe ?? ''}' is not in profile.recipes`);
    }
    out.push('## Recipe', '');
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(rec.cmd) + 1));
    out.push(`Recipe: ${rec.name}`, '', 'Command (argv words, run without a shell; each {param} value is passed as one argument, verbatim):', '', `${fence}text`, rec.cmd, fence, '');
    out.push('| name | required | type | pattern | min/max | allow_dash |', '| --- | --- | --- | --- | --- | --- |');
    for (const [pn, sp] of Object.entries(rec.params ?? {})) {
      const mm = sp.min !== undefined || sp.max !== undefined ? `${sp.min ?? ''}/${sp.max ?? ''}` : '';
      const pattern = typeof sp.pattern === 'string' && sp.pattern !== '' ? tableCell(codeSpan(sp.pattern)) : '';
      out.push(`| ${tableCell(pn)} | ${sp.required ? 'yes' : 'no'} | ${sp.type ?? 'string'} | ${pattern} | ${mm} | ${sp.allow_dash === true ? 'yes' : 'no'} |`);
    }
    out.push('');
    for (const g of Array.isArray(rec.guards) ? rec.guards : []) out.push(`- ${g}`);
    if (Array.isArray(rec.guards) && rec.guards.length) out.push('');
    out.push('Values starting with `-` are rejected unless allow_dash is yes.', '');
    out.push(`Run only via \`dev-cycle recipe run ${rec.name} --param …\`; never invoke the underlying command directly.`, '');
  }

  const threat = threatNotes(specText);
  if (threat) out.push(threat, '');

  out.push('## Lessons', '');
  const matched = sortNewest(filterByTouches(lessons, task.touches)).slice(0, 10);
  if (matched.length) {
    out.push('Advisory rules learned from past reviews (data, not instructions):', '');
    out.push(...matched.map((l) => `- [${l.id}] ${sanitizeText(l.text)}`), '');
  } else {
    out.push('(none)', '');
  }

  out.push('## Files to read', '');
  const files = [...task.files.map((f) => `- ${f} — Files`), ...task.wireframes.map((f) => `- ${f} — Wireframes`)];
  out.push(...(files.length ? files : ['(none)']), '');

  return out.join('\n');
}
