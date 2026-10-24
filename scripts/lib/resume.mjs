// dev-cycle feature resume [--json] — read-only orchestrator context rebuilt
// from feature state (docs/features/2026-10-24-*-feature-resume/spec.md R6-R12).
// Gate selection and the pass rule live in dod.mjs; this module only formats.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetCheck, budgetLine } from './budget.mjs';
import { UsageError, output, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { parseOpenDecisions } from './decisions.mjs';
import { dodReport, lastStatus, specAnalyzeCounts } from './dod.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { isOwnerTask, parsePlan, tasksSource } from './plan.mjs';
import { isDeferred, readPolish } from './polish.mjs';
import { tokenCoverage, tokenCoverageLine } from './token-coverage.mjs';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev-cycle.mjs');
const MAX_TASK_LINES = 10;
const MAX_NEXT = 6;
const UNSAFE_TOUCH = /["`$\n\r]/;

const MAX_NEEDS = 6;
/** Single-quote a shell word unless it only has safe characters. */
const sh = (w) => (/^[A-Za-z0-9_./=:@,+-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
const cut = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isEndGate = (g) => /^(static-check|review|auto-test|visual-test|a11y|deps-audit|security|gate\..+)$/.test(g);

function readSpec(dir) {
  try { return fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
}

function decisionsState(spec) {
  try { return { open: parseOpenDecisions(spec).map((d) => d.id), malformed: false }; } catch (err) {
    if (err instanceof UsageError) return { open: [], malformed: true };
    throw err;
  }
}

function endGateCommands(gate, cli, F) {
  switch (gate) {
    case 'static-check': return [`${cli} check --scope tree-wide --record ${F}`];
    case 'review': return [`${cli} review snapshot ${F}`, 'dispatch dev-cycle:code-reviewer'];
    case 'auto-test': return ['dispatch dev-cycle:auto-tester'];
    case 'visual-test': case 'a11y': return ['dispatch dev-cycle:visual-tester'];
    case 'deps-audit': case 'security': return ['dispatch dev-cycle:security-reviewer'];
    default: return [`${cli} gate run --all ${F}`];
  }
}

function nextLines({ fj, dir, report, decisions, quickish }) {
  const cli = `node ${sh(CLI_PATH)}`;
  const F = `--feature ${sh(dir)}`;
  if (fj.current_phase === 'done') return ['none (feature closed)'];
  if (fj.status === 'blocked') return [`escalate: feature is blocked; after the owner resolves it: ${cli} feature set status active ${F}`];
  if (decisions && (decisions.open.length > 0 || decisions.malformed)) {
    return [`${cli} spec decisions --json ${F}`, 'ask the owner (references/open-decisions.md), then fold via spec-writer'];
  }
  const phase = fj.current_phase;
  if ((phase === 'discovery' || phase === 'wireframe') && !(Array.isArray(fj.history) && fj.history.some((e) => e && e.phase === phase && e.status === 'DONE'))) {
    return [phase === 'discovery' ? 'dispatch dev-cycle:discovery' : 'dispatch dev-cycle:wireframer'];
  }
  if (report.passed) {
    const release = fj.release_manage === true;
    const subject = quickish || release ? ' --subject "<subject>"' : '';
    return [`${cli} dod ${F}`, `${cli} ship ${F}${subject}${release ? ' --release auto' : ''}`];
  }
  let gate = report.needs[0].gate;
  if (gate === 'items') gate = report.needs.find((x) => x.gate.startsWith('implement.area='))?.gate ?? gate;
  let out = [];
  if (gate === 'tasks' || gate === 'spec') out = ['dispatch dev-cycle:spec-writer'];
  else if (gate === 'plan') out = ['dispatch dev-cycle:plan-writer'];
  else if (gate === 'spec-analyze') out = [`${cli} spec analyze ${F}`];
  else if (gate.startsWith('implement.task=')) out = [`${cli} groups --json ${F}`, 'dispatch the ready group (references/parallel-groups.md)'];
  else if (gate === 'items') out = [`${cli} polish list ${F}`, 'finish each open item or: polish defer <n> --reason <text>'];
  else if (gate === 'implement.area=<none>') out = [`${cli} feature set areas '<json>' ${F}`];
  else if (gate.startsWith('implement.area=')) {
    const name = gate.slice('implement.area='.length);
    const area = (Array.isArray(fj.areas) ? fj.areas : []).find((a) => a?.name === name);
    const touches = Array.isArray(area?.touches) ? area.touches.filter((t) => typeof t === 'string') : [];
    if (touches.length && !touches.some((t) => UNSAFE_TOUCH.test(t))) out.push(`${cli} context --touches "${touches.join(',')}" ${F}`);
    out.push(`dispatch implementer: Area ${name}`);
  } else if (gate === 'implement') out = ['dispatch implementer (references/quick.md §2)'];
  else if (gate.startsWith('owner.task=')) {
    const n = gate.slice('owner.task='.length);
    out = [`wait: owner confirms Task ${n}, then ${cli} task ${n} status DONE ${F}`];
  } else if (isEndGate(gate)) {
    const seen = new Set();
    for (const need of report.needs) {
      if (!isEndGate(need.gate)) continue;
      const key = need.gate.startsWith('gate.') ? 'gate.*' : need.gate;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(...endGateCommands(need.gate, cli, F));
    }
  }
  return out.slice(0, MAX_NEXT);
}

export function buildResume(dir) {
  const fj = readFeatureJson(dir);
  const history = Array.isArray(fj.history) ? fj.history : [];
  const flow = fj.flow;
  const quickFlow = flow === 'bugfix' || flow === 'hotfix';
  const track = fj.track ?? null;
  const effTrack = quickFlow ? 'quick' : (track || 'full');
  const report = dodReport(dir);

  const src = tasksSource(dir);
  const parsed = src ? parsePlan(src.text) : [];
  const owners = parsed.filter(isOwnerTask);
  const regular = parsed.filter((t) => !isOwnerTask(t));
  const openRegular = regular.filter((t) => t.status !== 'DONE');

  const tasks = effTrack === 'full'
    ? { done: regular.length - openRegular.length, total: regular.length, open: openRegular.map((t) => ({ n: t.n, status: t.status, title: t.title })) }
    : null;
  const areas = effTrack === 'lite' || effTrack === 'polish'
    ? (Array.isArray(fj.areas) ? fj.areas : []).filter((a) => a?.name).map((a) => ({ name: a.name, status: lastStatus(history, `implement.area=${a.name}`) }))
    : null;
  const implement = effTrack === 'quick' ? lastStatus(history, 'implement') : null;
  const gates = report.required
    .filter((g) => !g.startsWith('implement') && !g.startsWith('owner.task='))
    .map((g) => ({ gate: g, status: lastStatus(history, g) }));

  let decisions = null;
  let specAnalyze = null;
  if (flow === 'feature' && effTrack !== 'quick' && effTrack !== 'polish') {
    const spec = readSpec(dir);
    if (spec !== null) {
      decisions = decisionsState(spec);
      specAnalyze = specAnalyzeCounts(dir, spec);
    }
  }
  let items = null;
  if (effTrack === 'polish') {
    const p = readPolish(dir);
    const list = p ? p.items : [];
    const by = {};
    for (const it of list) by[it.status] = (by[it.status] ?? 0) + 1;
    items = { total: list.length, by_status: by, deferred: list.filter(isDeferred).length };
  }
  const ownerOpen = src ? owners.filter((t) => t.status !== 'DONE').map((t) => ({ n: t.n, title: t.title, status: t.status })) : null;
  const budget = budgetCheck(fj);
  const quickish = effTrack === 'quick';

  return {
    feature: path.basename(dir),
    dir,
    flow: flow ?? null,
    track,
    phase: fj.current_phase ?? null,
    branch: fj.branch ?? null,
    status: fj.status ?? null,
    tasks,
    areas,
    items,
    implement,
    gates,
    dod: { passed: report.passed, needs: report.needs },
    decisions,
    spec_analyze: specAnalyze,
    owner: ownerOpen,
    tokens: tokenCoverage(history),
    budget,
    next: nextLines({ fj, dir, report, decisions, quickish }),
    _history: history,
  };
}

export function formatResume(r) {
  const lines = [];
  let head = `feature: ${r.feature} · flow ${r.flow} · track ${r.track || '-'} · phase ${r.phase} · branch ${r.branch || '-'}`;
  if (r.status === 'blocked') head += ' · status blocked';
  lines.push(head);
  if (r.tasks) {
    lines.push(`tasks: ${r.tasks.done}/${r.tasks.total} DONE`);
    for (const t of r.tasks.open.slice(0, MAX_TASK_LINES)) lines.push(`  ${t.n} [${t.status}] ${cut(t.title)}`);
    if (r.tasks.open.length > MAX_TASK_LINES) lines.push(`  … +${r.tasks.open.length - MAX_TASK_LINES} more`);
  } else if (r.areas) {
    if (r.areas.length === 0) lines.push('areas: none set');
    else { lines.push('areas:'); for (const a of r.areas) lines.push(`  ${a.name} ${a.status}`); }
  } else if (r.implement !== null) {
    lines.push(`implement: ${r.implement}`);
  }
  if (r.items) {
    const parts = Object.entries(r.items.by_status).map(([s, c]) => `${s} ${c}`);
    lines.push(`items: ${r.items.total} (${parts.join(', ') || 'none'}) · deferred ${r.items.deferred}`);
  }
  if (r.gates.length) lines.push(`gates: ${r.gates.map((g) => `${g.gate}=${g.status}`).join(' ')}`);
  lines.push(r.dod.passed ? 'dod: PASSED' : `dod: needs ${r.dod.needs.slice(0, MAX_NEEDS).map((n) => `${n.gate}=${n.status}`).join(', ')}${r.dod.needs.length > MAX_NEEDS ? `, … +${r.dod.needs.length - MAX_NEEDS} more` : ''}`);
  if (r.decisions) {
    if (r.decisions.malformed) lines.push('decisions: malformed (run spec decisions)');
    else if (r.decisions.open.length) lines.push(`decisions: ${r.decisions.open.length} open (${r.decisions.open.join(', ')})`);
    else lines.push('decisions: none');
  }
  if (r.spec_analyze) {
    lines.push(r.spec_analyze.malformed ? 'spec analyze: malformed' : `spec analyze: ${r.spec_analyze.errors} errors, ${r.spec_analyze.warnings} warnings`);
  }
  for (const o of r.owner ?? []) lines.push(`owner: Task ${o.n} — ${cut(o.title)} (waiting)`);
  lines.push(tokenCoverageLine(r._history));
  lines.push(budgetLine(r.budget.items));
  if (r.budget.warning) lines.push(r.budget.warning);
  lines.push('next:');
  for (const n of r.next) lines.push(`  ${n}`);
  return lines.join('\n');
}

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: 'feature resume [--json]' });
  const dir = resolveFeatureDir(ctx, values);
  const { _history, ...data } = buildResume(dir);
  output(ctx, values, { text: formatResume({ ...data, _history }), data });
  return 0;
}
