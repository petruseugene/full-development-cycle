// dev-cycle spec status <S> | spec decisions [--json] | spec amend ... | spec analyze [--json]
// Rewrites spec.md frontmatter status; on DONE also plan.md frontmatter status.

import path from 'node:path';
import { UsageError, parseCommandArgs, output, resolveFeatureDir, readText, atomicWrite } from './core.mjs';
import { parseOpenDecisions } from './decisions.mjs';
import { normalizeStatus, setFrontmatterStatus, STATUSES, tasksSource } from './plan.mjs';
import { analyzeSpec } from './spec-analyze.mjs';
import { applySupersede, insertAmendment, parseSupersedeArg, today, validateDate, validateTitle } from './spec-amend.mjs';

const USAGE = 'spec status <S> | spec decisions [--json] | spec amend --title <t> [--date d] | spec amend --supersede ACx=ACy… | spec analyze [--json]';

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      title: { type: 'string' },
      date: { type: 'string' },
      supersede: { type: 'string', multiple: true },
    },
    positionals: ['verb', 'status?'],
  });
  if (args.verb === 'analyze') return analyze(args, values, ctx);
  if (args.verb === 'amend') return amend(args, values, ctx);
  if (args.verb === 'decisions') {
    if (args.status !== undefined) throw new UsageError(`unexpected argument '${args.status}' (usage: dev-cycle ${USAGE})`);
    const decisions = parseOpenDecisions(readText(path.join(resolveFeatureDir(ctx, values), 'spec.md')));
    const text = decisions.length
      ? decisions.map((d) => `${d.id}: ${d.question} [${d.options.map((o) => (o.recommended ? `${o.label} (Recommended)` : o.label)).join(' | ')}]`)
      : 'no open decisions';
    output(ctx, values, { text, data: { decisions } });
    return 0;
  }
  if (args.verb !== 'status') throw new UsageError(`unknown subcommand '${args.verb}' (usage: dev-cycle ${USAGE})`);
  if (args.status === undefined) throw new UsageError(`missing <status> (usage: dev-cycle ${USAGE})`);
  const status = normalizeStatus(args.status);
  if (!status) throw new UsageError(`unknown status '${args.status}' (expected one of ${STATUSES.join(', ')})`);

  const dir = resolveFeatureDir(ctx, values);
  const specFile = path.join(dir, 'spec.md');
  const planFile = path.join(dir, 'plan.md');

  const spec = readText(specFile);
  const newSpec = setFrontmatterStatus(spec, status);
  if (newSpec === null) throw new UsageError(`no 'status:' line in the frontmatter of ${specFile}`);

  let plan = null;
  let newPlan = null;
  if (status === 'DONE') {
    plan = readText(planFile, { optional: true });
    if (plan !== null) newPlan = setFrontmatterStatus(plan, status);
  }

  if (newSpec !== spec) atomicWrite(specFile, newSpec, { expected: spec });
  const files = ['spec.md'];
  if (newPlan !== null) {
    if (newPlan !== plan) atomicWrite(planFile, newPlan, { expected: plan });
    files.push('plan.md');
  }
  output(ctx, values, { text: `spec status ${status}`, data: { status, files } });
  return 0;
}

function analyze(args, values, ctx) {
  if (args.status !== undefined) throw new UsageError(`unexpected argument '${args.status}' (usage: dev-cycle ${USAGE})`);
  const dir = resolveFeatureDir(ctx, values);
  const specText = readText(path.join(dir, 'spec.md'));
  const tasksText = tasksSource(dir)?.text ?? null;
  const reportText = readText(path.join(dir, 'test-report.md'), { optional: true });
  const { errors, warnings, checked } = analyzeSpec({ specText, tasksText, reportText });
  const text = [
    ...errors.map((f) => `error ${f.code}: ${f.message}`),
    ...warnings.map((f) => `warn ${f.code}: ${f.message}`),
    ...(checked.tasks ? [] : ['tasks: n/a (no tasks file)']),
    `spec analyze: ${errors.length} error(s), ${warnings.length} warning(s)`,
  ];
  output(ctx, values, { text, data: { errors, warnings, checked } });
  return errors.length ? 1 : 0;
}

function amend(args, values, ctx) {
  if (args.status !== undefined) throw new UsageError(`unexpected argument '${args.status}' (usage: dev-cycle ${USAGE})`);
  const supersede = values.supersede ?? [];
  const hasTitle = values.title !== undefined;
  const hasSupersede = supersede.length > 0;
  if (hasTitle === hasSupersede) {
    throw new UsageError(`spec amend needs exactly one of --title / --supersede (usage: dev-cycle ${USAGE})`);
  }
  if (hasSupersede && values.date !== undefined) throw new UsageError('--date applies to --title only');
  const file = path.join(resolveFeatureDir(ctx, values), 'spec.md');
  const before = readText(file);
  if (hasTitle) {
    const title = validateTitle(values.title);
    const date = validateDate(values.date ?? today());
    const r = insertAmendment(before, { title, date });
    if (r.inserted) atomicWrite(file, r.text, { expected: before });
    output(ctx, values, {
      text: `next AC: AC${r.nextAc}`,
      data: { heading: r.heading, next_ac: `AC${r.nextAc}`, inserted: r.inserted },
    });
    return 0;
  }
  const pairs = supersede.map(parseSupersedeArg);
  const after = applySupersede(before, pairs);
  atomicWrite(file, after, { expected: before });
  output(ctx, values, {
    text: pairs.map((p) => `AC${p.x} superseded → ${p.by.map((n) => `AC${n}`).join(', ')}`),
    data: { superseded: pairs.map((p) => ({ ac: `AC${p.x}`, by: p.by.map((n) => `AC${n}`) })) },
  });
  return 0;
}
