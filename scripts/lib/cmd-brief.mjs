// dev-cycle brief <n> — writes <feature>/briefs/task-<n>.md (spec R16).

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, atomicWrite, output, parseCommandArgs, readText, resolveFeatureDir, resolveProjectRoot } from './core.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { findTask, parsePlan, requireTasksSource } from './plan.mjs';
import { buildBrief } from './brief.mjs';
import { LESSONS_REL, parseLessons } from './lessons.mjs';
import { readMapText } from './map.mjs';

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, { usage: 'brief <n> [--json] [--feature <dir>]', positionals: ['n'] });
  if (!/^\d+$/.test(args.n)) throw new UsageError(`task number must be a positive integer (got '${args.n}')`);
  const n = Number(args.n);
  const dir = resolveFeatureDir(ctx, values);
  const fj = readFeatureJson(dir);
  const track = fj.track || 'full';
  if (track !== 'full') throw new UsageError(`brief works only on track full (this feature is '${track}')`);

  // Task detail from the resolved tasks source (plan.md or spec.md, R38);
  // ACs always come from spec.md.
  const src = requireTasksSource(dir);
  const task = findTask(parsePlan(src.text), n);
  if (!task) throw new UsageError(`task ${n} not found in ${path.basename(src.file)}`);
  const specText = readText(path.join(dir, 'spec.md'));

  const lessonsText = readText(path.join(resolveProjectRoot(ctx), LESSONS_REL), { optional: true });
  const lessons = parseLessons(lessonsText ?? '').lessons;
  const text = buildBrief({ task, specText, fj, lessons, map: readMapText(resolveProjectRoot(ctx)) });
  const file = path.join(dir, 'briefs', `task-${n}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, text);
  output(ctx, values, { text: file, data: { path: file, task: n } });
  return 0;
}
