// dev-cycle dod — read-only Definition-of-Done gate (spec R12).

import { FailedError, output, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { evaluateDod } from './dod.mjs';

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: 'dod' });
  const dir = resolveFeatureDir(ctx, values);
  const res = evaluateDod(dir);
  if (res.passed) {
    output(ctx, values, { text: 'DOD-GATE PASSED', data: { passed: true, required: res.required } });
    return 0;
  }
  const line = `! DOD-GATE FAILED: ${res.failed.gate} last status = ${res.failed.status}; aborting before push.`;
  output(ctx, values, { text: line, data: { passed: false, required: res.required, failed: res.failed } });
  throw new FailedError('');
}
