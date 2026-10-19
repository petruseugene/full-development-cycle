// check [--scope touched|tree-wide] [--files <a,b,…>]... [--steps lint,typecheck,format,test]
//       [--record] [--tail <n>] [--timeout <s>] [--json] [--feature <dir>]   (spec R1-R10)
//
// Runs the project's read-only check commands. Per step the command comes
// from the feature snapshot profile.commands, then .dev-cycle/project.json
// commands, then stack detection. Quiet on success.
//
// Logs: only tree-wide runs write <feature>/checks/<step>.log and (on FAILED)
// static-check-report.md; a PASSED tree-wide run removes a stale report.
// Touched runs (parallel implementers) log to a private temp file instead.
//
// Security: touched files are validated (no newline/NUL, inside the repo
// root), prefixed with `./` when they start with `-`, and POSIX-single-quoted
// before they replace `{files}` (a quoted `"{files}"` template exits 2);
// command strings themselves are passed verbatim to the shell like `gate run`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UsageError, atomicWrite, output, parseCommandArgs, resolveFeatureForWrite, resolveProjectRoot,
} from './core.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { appendHistory } from './history.mjs';
import { COMMAND_KEYS, loadProfile } from './profile.mjs';
import { DEFAULT_TIMEOUT_S, runStep as defaultRunStep } from './runner.mjs';
import { detectFromDir, failsOnOutput } from './stack-detect.mjs';
import { classify, extractFailures } from './test-failures.mjs';

const USAGE = 'check [--scope touched|tree-wide] [--files <a,b,…>]... [--steps lint,typecheck,format,test] [--record] [--tail <n>] [--timeout <s>] [--json] [--feature <dir>]';
export const HELP = `usage: dev-cycle ${USAGE}

Runs the project's read-only check commands (profile.commands → .dev-cycle/project.json → stack detection).

  --scope touched     only report failures in --files (required); no logs or report are written
  --scope tree-wide   default; logs to <feature>/checks/<step>.log and writes static-check-report.md
  --steps             explicit steps. Default: lint,typecheck,format. Tree-wide adds \`test\` only when
                      feature.json auto_tests is false (tests are owned by auto-tester otherwise);
                      pass --steps lint,typecheck,test to run tests tree-wide regardless.
  --record            append a static-check history entry (needs a feature folder)

The test step prints only the failing-test blocks plus \`check: FAILED test (<k> failing; log: <path>)\`;
under --scope touched a non-zero test exit is never PASSED (failures are split into touched / elsewhere).
When the newest feature folder is closed (current_phase done) and no --feature is given, nothing is
written into it: logs go to a temp dir and --record exits 2.

A profile command may contain an unquoted {files} placeholder; quoted forms ("{files}", '{files}') are rejected.
`;
export const SCOPES = Object.freeze(['touched', 'tree-wide']);
export const DEFAULT_TAIL = 60;
export const REPORT_FILE = 'static-check-report.md';

/** POSIX shell single-quoting: 'a b' → `'a b'`, it's → `'it'\''s'`. */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate and normalise touched files (R10). Returns repo-relative paths.
 * Throws UsageError for a newline/NUL or a path that resolves outside root.
 */
export function normalizeFiles(raw, root) {
  const out = [];
  for (const entry of raw) {
    for (const part of String(entry).split(',')) {
      if (/[\n\r\0]/.test(part)) throw new UsageError('--files: paths must not contain a newline or NUL');
      const f = part.trim();
      if (f === '') continue;
      const rel = path.relative(root, path.resolve(root, f));
      if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new UsageError(`--files: path resolves outside the repo root: ${f}`);
      }
      // A leading `-` would be read as an option by the tool (security S2).
      const safe = rel.startsWith('-') ? `.${path.sep}${rel}` : rel;
      if (!out.includes(safe)) out.push(safe);
    }
  }
  return out;
}

/** Default steps (R4). */
export function defaultSteps(scope, fj) {
  const steps = ['lint', 'typecheck', 'format'];
  if (scope === 'tree-wide' && fj && fj.auto_tests === false) steps.push('test');
  return steps;
}

function isCmd(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Resolve one command per step (R2). First match wins:
 * feature snapshot profile.commands → project profile commands → detection.
 * Steps without a command are omitted.
 * @returns {Array<{step: string, cmd: string, source: 'feature'|'project'|'detect'}>}
 */
export function resolveCommands(steps, { featureCommands, projectCommands, detect }) {
  let detected;
  const out = [];
  for (const step of steps) {
    if (isCmd(featureCommands?.[step])) { out.push({ step, cmd: featureCommands[step], source: 'feature' }); continue; }
    if (isCmd(projectCommands?.[step])) { out.push({ step, cmd: projectCommands[step], source: 'project' }); continue; }
    detected ??= detect() || {};
    if (isCmd(detected[step])) out.push({ step, cmd: detected[step], source: 'detect' });
  }
  return out;
}

/**
 * Reject a `{files}` placeholder sitting next to a quote character (security
 * S1): our own single-quoting would be undone or nested, letting `$(…)` in a
 * crafted filename run. Throws UsageError (exit 2).
 */
export function assertUnquotedPlaceholder(cmd, step = 'command') {
  if (/["'`]\{files\}|\{files\}["'`]/.test(cmd)) {
    throw new UsageError(`${step}: the {files} placeholder must not be quoted (got: ${cmd}); write {files} bare — paths are shell-quoted for you`);
  }
}

/** Replace `{files}` (R6): quoted touched files, or `.` on tree-wide. */
export function substituteFiles(cmd, scope, files) {
  assertUnquotedPlaceholder(cmd);
  const value = scope === 'touched' ? files.map(shellQuote).join(' ') : '.';
  return cmd.split('{files}').join(value);
}

function lines(text) {
  return String(text ?? '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
}

/** Output lines mentioning a touched path, repo-relative or absolute (R6). */
export function filterLines(all, files, root) {
  const needles = files.flatMap((f) => [f, path.join(root, f)]);
  return all.filter((l) => needles.some((n) => l.includes(n)));
}

function positiveInt(name, raw, { min }) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < min) {
    throw new UsageError(`--${name} must be an integer >= ${min} (got '${raw}')`);
  }
  return Number(raw);
}

function readSnapshot(featureDir) {
  if (!featureDir || !fs.existsSync(path.join(featureDir, 'feature.json'))) return null;
  return readFeatureJson(featureDir);
}

/** A passing tree-wide run removes a stale FAILED report (review F5). */
function removeReport(featureDir) {
  try { fs.rmSync(path.join(featureDir, REPORT_FILE), { force: true }); } catch { /* best effort */ }
}

function writeReport(featureDir, failed, ts) {
  const body = [
    '# Static check report',
    '',
    `- Status: FAILED`,
    `- Scope: tree-wide`,
    `- Generated: ${ts} by \`dev-cycle check\``,
    `- Failing steps: ${failed.map((s) => s.step).join(', ')}`,
    '',
  ];
  for (const s of failed) {
    body.push(`## ${s.step}`, '', `- Command: \`${s.cmd}\``,
      `- Exit: ${s.timed_out ? 'timed out' : s.exit}`, '', '```text', ...(s.tail ? s.tail.split('\n') : []), '```', '');
  }
  atomicWrite(path.join(featureDir, REPORT_FILE), body.join('\n'));
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{runStep?: typeof defaultRunStep, detect?: (root: string) => Record<string,string>}} [seams]
 */
export async function run(argv, ctx, { runStep = defaultRunStep, detect = detectFromDir } = {}) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      scope: { type: 'string', default: 'tree-wide' },
      files: { type: 'string', multiple: true },
      steps: { type: 'string' },
      record: { type: 'boolean' },
      tail: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    ctx.stdout.write(HELP);
    return 0;
  }
  const scope = values.scope;
  if (!SCOPES.includes(scope)) throw new UsageError(`--scope must be touched or tree-wide (got '${scope}')`);
  const tailN = positiveInt('tail', values.tail, { min: 0 }) ?? DEFAULT_TAIL;
  const timeout_s = positiveInt('timeout', values.timeout, { min: 1 }) ?? DEFAULT_TIMEOUT_S;

  const root = resolveProjectRoot(ctx);
  const files = normalizeFiles(values.files ?? [], root);
  if (scope === 'touched' && files.length === 0) throw new UsageError(`--files is required for --scope touched (usage: dev-cycle ${USAGE})`);

  let steps;
  if (values.steps !== undefined) {
    steps = [...new Set(values.steps.split(',').map((s) => s.trim()).filter(Boolean))];
    const bad = steps.filter((s) => !COMMAND_KEYS.includes(s));
    if (steps.length === 0 || bad.length) {
      throw new UsageError(`--steps must be a comma list of ${COMMAND_KEYS.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`);
    }
  }

  const featureDir = resolveFeatureForWrite(ctx, values);
  if (values.record && !featureDir) throw new UsageError('--record needs a feature folder (--feature or DEV_CYCLE_FEATURE; a closed feature folder is not auto-selected)');
  const fj = readSnapshot(featureDir);
  steps ??= defaultSteps(scope, fj);

  const resolved = resolveCommands(steps, {
    featureCommands: fj?.profile?.commands,
    projectCommands: loadProfile(ctx, { quiet: true }).profile.commands,
    detect: () => detect(root),
  });
  for (const { step, cmd } of resolved) assertUnquotedPlaceholder(cmd, step);
  if (resolved.length === 0) {
    ctx.stderr.write(`check: no check commands found (scope ${scope})\n`);
    return 2;
  }

  const started = Date.now();
  const results = [];
  const text = [];
  let tmpLogDir = null;
  const tmpLog = (step) => {
    tmpLogDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-check-'));
    return path.join(tmpLogDir, `${step}.log`);
  };
  for (const { step, cmd: raw } of resolved) {
    const usesFiles = raw.includes('{files}');
    const cmd = substituteFiles(raw, scope, files);
    // Only tree-wide runs with a live feature folder write feature-folder logs
    // (parallel touched runs would truncate a shared log, review F4); a closed
    // or missing folder logs to a temp dir. The test step always keeps a log.
    let logPath;
    if (featureDir && scope === 'tree-wide') logPath = path.join(featureDir, 'checks', `${step}.log`);
    else if (step === 'test' || (!featureDir && scope === 'tree-wide')) logPath = tmpLog(step);
    const res = await runStep({ cmd, timeout_s, logPath, featureDir: featureDir ?? '', root });
    const all = lines(res.output);

    if (step === 'test') {
      // Never PASSED on a non-zero exit, in any scope: a failure outside the
      // touched files may be a sibling's in-flight edit, but it is still shown.
      const passed = res.status === 'PASSED';
      const blocks = passed ? [] : extractFailures(res.output, { tail: tailN || undefined });
      const entry = {
        step, cmd, exit: res.exitCode, passed, timed_out: res.timedOut, log: logPath ?? null,
        failing: blocks.length, tail: '',
      };
      if (!passed) {
        text.push(`FAIL ${step} (exit ${res.timedOut ? `timeout after ${timeout_s}s` : res.exitCode}): ${cmd}`);
        if (blocks.length === 0) {
          entry.tail = (tailN === 0 ? [] : all.slice(-tailN)).join('\n');
          if (entry.tail) text.push(...entry.tail.split('\n'));
        } else if (scope === 'touched') {
          const g = classify(blocks, files);
          entry.touched_failures = g.touched.length;
          entry.elsewhere_failures = g.elsewhere.length;
          text.push(`failures in touched files (${g.touched.length})`, ...g.touched.map((b) => b.text));
          text.push(`failures elsewhere — possibly in-flight sibling edits (${g.elsewhere.length})`, ...g.elsewhere.map((b) => b.text));
          entry.tail = blocks.map((b) => b.text).join('\n');
        } else {
          entry.tail = blocks.map((b) => b.text).join('\n');
          text.push(...blocks.flatMap((b) => b.text.split('\n')));
        }
      }
      results.push(entry);
      continue;
    }

    const shown = scope === 'touched' && !usesFiles ? filterLines(all, files, root) : all;
    let passed = res.status === 'PASSED' && !(failsOnOutput(cmd) && shown.length > 0);
    if (!passed && !res.timedOut && scope === 'touched' && !usesFiles && shown.length === 0) {
      passed = true;
      text.push(`${step}: failures outside touched files (${all.length} lines) — ignored for touched scope`);
    }
    const tail = tailN === 0 ? [] : shown.slice(-tailN);
    results.push({ step, cmd, exit: res.exitCode, passed, timed_out: res.timedOut, tail: tail.join('\n') });
    if (!passed) {
      text.push(`FAIL ${step} (exit ${res.timedOut ? `timeout after ${timeout_s}s` : res.exitCode}): ${cmd}`, ...tail);
    }
  }

  const failed = results.filter((r) => !r.passed);
  const passed = failed.length === 0;
  const label = (r) => (r.step === 'test' ? `test (${r.failing} failing; log: ${r.log ?? 'none'})` : r.step);
  const summary = passed ? `check: PASSED (${results.length} steps)` : `check: FAILED ${failed.map(label).join(', ')}`;
  text.push(summary);

  if (scope === 'tree-wide' && featureDir) {
    if (passed) removeReport(featureDir);
    else writeReport(featureDir, failed, new Date().toISOString());
  }
  if (tmpLogDir && passed) {
    try { fs.rmSync(tmpLogDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (values.record) {
    appendHistory(featureDir, {
      phase: 'static-check',
      subagent: 'cli',
      executor: 'cli',
      status: passed ? 'PASSED' : 'FAILED',
      duration_s: Math.round((Date.now() - started) / 1000),
      summary: `${scope}: ${summary.replace(/^check: /, '')}`,
    });
  }

  output(ctx, values, { text, data: { passed, steps: results } });
  return passed ? 0 : 1;
}
