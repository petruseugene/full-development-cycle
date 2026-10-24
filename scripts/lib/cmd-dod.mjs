// dev-cycle dod — read-only Definition-of-Done gate (spec R12).

import { FailedError, output, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { evaluateDod } from './dod.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { tokenCoverage, tokenCoverageLine } from './token-coverage.mjs';

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: 'dod' });
  const dir = resolveFeatureDir(ctx, values);
  const res = evaluateDod(dir);
  const history = readFeatureJson(dir).history;
  const tokens = tokenCoverage(history);
  const tline = tokenCoverageLine(history);
  if (res.passed) {
    output(ctx, values, { text: `DOD-GATE PASSED\n${tline}`, data: { passed: true, required: res.required, tokens } });
    return 0;
  }
  const line = `! DOD-GATE FAILED: ${res.failed.gate} last status = ${res.failed.status}; aborting before push.`;
  output(ctx, values, { text: `${line}\n${tline}`, data: { passed: false, required: res.required, failed: res.failed, tokens } });
  throw new FailedError('');
}
