// dev-cycle groups [--all] [--json]

import { parseCommandArgs, output, resolveFeatureDir, warn } from './core.mjs';
import { parsePlan, requireTasksSource } from './plan.mjs';
import { computeGroups } from './groups.mjs';

const USAGE = 'groups [--all] [--json]';

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: { all: { type: 'boolean' } },
  });
  const planText = requireTasksSource(resolveFeatureDir(ctx, values)).text;
  const { groups, held } = computeGroups(parsePlan(planText), { all: Boolean(values.all) });
  if (held.length) warn(ctx, `tasks waiting on BLOCKED/owner dependencies omitted: ${held.join(', ')}`);
  output(ctx, values, {
    text: groups.length
      ? groups.map((g, i) => `group ${i + 1}${g.length > 1 ? ' (parallel)' : ''}: ${g.map((n) => `task ${n}`).join(', ')}`)
      : 'no runnable tasks',
    data: groups,
  });
  return 0;
}
