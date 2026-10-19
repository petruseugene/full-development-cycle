// post-merge run <name>|--all [--confirmed] — runs feature.json.profile.post_merge (spec R14).
// Steps with `confirm: true` never run without --confirmed.

import path from 'node:path';
import { output } from './core.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { runStep, selectSteps, pickSteps } from './runner.mjs';

const USAGE = 'post-merge run <name>|--all [--confirmed] [--json] [--feature <dir>]';

export async function run(argv, ctx) {
  const { values, name, featureDir, root } = selectSteps(argv, ctx, {
    usage: USAGE, label: 'post-merge step', extraOptions: { confirmed: { type: 'boolean' } },
  });
  const steps = readFeatureJson(featureDir).profile?.post_merge;
  if (!Array.isArray(steps) || steps.length === 0) {
    if (!values.all) pickSteps([], name, false, 'post-merge step');
    output(ctx, values, { text: 'no post-merge steps', data: { steps: [], message: 'no post-merge steps' } });
    return 0;
  }
  const picked = pickSteps(steps, name, values.all, 'post-merge step');

  const results = [];
  for (const step of picked) {
    if (step.confirm === true && !values.confirmed) {
      results.push({ name: step.name, status: 'NOT_CONFIRMED', cmd: step.cmd });
      if (!values.json) {
        output(ctx, values, { text: `post-merge ${step.name}: needs --confirmed; not run. Command: ${step.cmd}` });
      }
      continue;
    }
    const logPath = path.join(featureDir, 'post-merge', `${step.name}.log`);
    const res = await runStep({
      cmd: step.cmd, timeout_s: step.timeout_s, logPath, featureDir, root,
      stdout: values.json ? undefined : ctx.stdout,
    });
    results.push({ name: step.name, status: res.status, exitCode: res.exitCode, timedOut: res.timedOut, log: logPath });
    if (!values.json) {
      output(ctx, values, { text: `post-merge ${step.name}: ${res.status}${res.timedOut ? ' (timeout)' : ''} (log: ${path.relative(root, logPath)})` });
    }
  }
  if (values.json) output(ctx, values, { data: { steps: results } });
  return results.some((r) => r.status !== 'PASSED') ? 1 : 0;
}
