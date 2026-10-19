// dev-cycle spec status <S>
// Rewrites spec.md frontmatter status; on DONE also plan.md frontmatter status.

import path from 'node:path';
import { UsageError, parseCommandArgs, output, resolveFeatureDir, readText, atomicWrite } from './core.mjs';
import { normalizeStatus, setFrontmatterStatus, STATUSES } from './plan.mjs';

const USAGE = 'spec status <S>';

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    positionals: ['verb', 'status'],
  });
  if (args.verb !== 'status') throw new UsageError(`unknown subcommand '${args.verb}' (usage: dev-cycle ${USAGE})`);
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
