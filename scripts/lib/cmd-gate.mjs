// gate run <name>|--all — runs feature.json.profile.extra_gates (spec R13).
// With no resolved feature (none, or the newest one is closed) the gates come
// from the project profile (.dev-cycle/project.json) and nothing is written
// into a feature folder: logs go to a temp dir, history is not touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { output } from './core.mjs';
import { readFeatureJson, updateFeatureJson } from './feature-json.mjs';
import { loadProfile } from './profile.mjs';
import { runStep, selectSteps, pickSteps } from './runner.mjs';

const USAGE = 'gate run <name>|--all [--json] [--feature <dir>]';
const PROFILE_REL = '.dev-cycle/project.json';

function profileGates(ctx) {
  const gates = loadProfile(ctx, { quiet: true }).profile.extra_gates;
  return Array.isArray(gates) ? gates : [];
}

export async function run(argv, ctx) {
  const { values, name, featureDir, root } = selectSteps(argv, ctx, { usage: USAGE, label: 'gate', closedAsNull: true });
  const fromProfile = !featureDir;
  const gates = fromProfile ? profileGates(ctx) : readFeatureJson(featureDir).profile?.extra_gates;
  if (!Array.isArray(gates) || gates.length === 0) {
    if (!values.all) pickSteps([], name, false, 'gate'); // unknown gate → usage error
    output(ctx, values, { text: 'no extra gates', data: { gates: [], message: 'no extra gates' } });
    return 0;
  }
  const picked = pickSteps(gates, name, values.all, 'gate');
  const source = fromProfile
    ? `gates from project profile (${PROFILE_REL}): ${gates.length}`
    : `gates from feature snapshot (project profile: ${profileGates(ctx).length} gates)`;
  if (!values.json) output(ctx, values, { text: source });

  const tmpDir = fromProfile ? fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-gate-')) : null;
  const results = [];
  for (const gate of picked) {
    const logPath = path.join(tmpDir ?? featureDir, ...(tmpDir ? [] : ['gates']), `${gate.name}.log`);
    const res = await runStep({
      cmd: gate.cmd, timeout_s: gate.timeout_s, logPath, featureDir: featureDir ?? '', root,
      stdout: values.json ? undefined : ctx.stdout,
    });
    if (featureDir) {
      updateFeatureJson(featureDir, (fj) => {
        if (!Array.isArray(fj.history)) fj.history = [];
        fj.history.push({
          ts: new Date().toISOString(),
          phase: `gate.${gate.name}`,
          subagent: 'gate',
          status: res.status,
          duration_s: res.duration_s,
        });
      });
    }
    results.push({ name: gate.name, status: res.status, exitCode: res.exitCode, timedOut: res.timedOut, log: logPath });
  }
  const failed = results.some((r) => r.status !== 'PASSED');
  // all passed without a feature: drop the temp log dir (its paths would be dead); on failure it stays
  const discarded = Boolean(tmpDir) && !failed;
  if (discarded) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const r of results) r.log = null;
  }
  if (!values.json) {
    for (const r of results) {
      const shown = r.log === null ? 'logs discarded' : `log: ${tmpDir ? r.log : path.relative(root, r.log)}`;
      output(ctx, values, { text: `gate ${r.name}: ${r.status}${r.timedOut ? ' (timeout)' : ''} (${shown})` });
    }
    if (tmpDir && !discarded) output(ctx, values, { text: `gate logs kept in ${tmpDir}` });
  }
  if (values.json) output(ctx, values, { data: { gates: results, source } });
  return failed ? 1 : 0;
}
