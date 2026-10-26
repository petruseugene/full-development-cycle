// dev-cycle dod — read-only Definition-of-Done gate (spec R12).

import { FailedError, output, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { dodReport } from './dod.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { tokenCoverage, tokenCoverageLine } from './token-coverage.mjs';

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: 'dod' });
  const dir = resolveFeatureDir(ctx, values);
  const rep = dodReport(dir);
  const res = rep.passed ? { passed: true, required: rep.required } : { passed: false, required: rep.required, failed: rep.failed };
  const resolved = rep.checks.filter((c) => c.note).map((c) => ({ gate: c.gate, note: c.note }));
  const rlines = resolved.map((r) => `${r.gate}: ${r.note}\n`).join('');
  const history = readFeatureJson(dir).history;
  const tokens = tokenCoverage(history);
  const tline = tokenCoverageLine(history);
  if (res.passed) {
    output(ctx, values, { text: `DOD-GATE PASSED\n${rlines}${tline}`, data: { passed: true, required: res.required, ...(resolved.length ? { resolved } : {}), tokens } });
    return 0;
  }
  const line = `! DOD-GATE FAILED: ${res.failed.gate} last status = ${res.failed.status}; aborting before push.${res.failed.hint ? `\n${res.failed.hint}` : ''}`;
  output(ctx, values, { text: `${line}\n${rlines}${tline}`, data: { passed: false, required: res.required, failed: res.failed, ...(resolved.length ? { resolved } : {}), tokens } });
  throw new FailedError('');
}
