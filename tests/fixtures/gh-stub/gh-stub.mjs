// Stub `gh` for git tests (spec AC17-AC21). Run via the wrapper that
// scripts/test/git-helpers.mjs writes and points DEV_CYCLE_GH at.
//
// Env:
//   GH_STUB_LOG     JSONL file; one {argv, env:{GH_PROMPT_DISABLED}} line per call.
//   GH_STUB_SCRIPT  JSON file: an array of rules, first match wins:
//     { "match": "auth status",          // argv joined by spaces must start with this
//       "exit": 0, "stdout": "", "stderr": "",
//       "sequence": [ {exit, stdout, stderr}, ... ] }   // optional: one per call, last repeats
//   Unmatched calls exit 0 with empty output.

import fs from 'node:fs';

const argv = process.argv.slice(2);
const joined = argv.join(' ');
const logFile = process.env.GH_STUB_LOG;
if (logFile) {
  fs.appendFileSync(logFile, JSON.stringify({ argv, env: { GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED ?? null } }) + '\n');
}

let rules = [];
if (process.env.GH_STUB_SCRIPT) {
  try { rules = JSON.parse(fs.readFileSync(process.env.GH_STUB_SCRIPT, 'utf8')); } catch { rules = []; }
}

let response = { exit: 0, stdout: '', stderr: '' };
const idx = rules.findIndex((r) => r && typeof r.match === 'string' && (joined === r.match || joined.startsWith(`${r.match} `)));
if (idx !== -1) {
  const rule = rules[idx];
  if (Array.isArray(rule.sequence) && rule.sequence.length > 0) {
    const stateFile = `${process.env.GH_STUB_SCRIPT}.state.json`;
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    const n = state[idx] ?? 0;
    state[idx] = n + 1;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    response = { ...response, ...rule.sequence[Math.min(n, rule.sequence.length - 1)] };
  } else {
    response = { ...response, ...rule };
  }
}

if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exitCode = Number.isInteger(response.exit) ? response.exit : 0;
