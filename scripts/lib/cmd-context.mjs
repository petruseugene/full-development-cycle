// dev-cycle context [--touches <g,..>] [--json]
// Read-only prompt appendix for lite/quick implementer prompts: the lessons
// block (same text as `lessons list --touches`) plus the project-map slice.

import path from 'node:path';
import { parseCommandArgs, readText, resolveProjectRoot } from './core.mjs';
import { PROMPT_LABEL } from './cmd-lessons.mjs';
import { LESSONS_REL, filterByTouches, formatLesson, parseLessons, sortNewest } from './lessons.mjs';
import { readMapText, sliceMap } from './map.mjs';

const USAGE = 'context [--touches <g,..>] [--json]';

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: USAGE, options: { touches: { type: 'string' } } });
  const root = resolveProjectRoot(ctx);
  const touches = (values.touches ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const parsed = parseLessons(readText(path.join(root, LESSONS_REL), { optional: true }) ?? '');
  const items = sortNewest(filterByTouches(parsed.lessons.filter((l) => !l.invalid), touches));
  const slice = sliceMap(readMapText(root), touches);

  if (values.json) {
    const lessons = items.map(({ id, globs, text, date, slug, ref }) => ({ id, globs, text, date, slug, ref }));
    ctx.stdout.write(JSON.stringify({ lessons, map: slice }) + '\n');
    return 0;
  }
  const parts = [];
  if (items.length) parts.push([PROMPT_LABEL, ...items.map((l) => formatLesson(l))].join('\n'));
  if (slice) parts.push(slice.replace(/\n+$/, ''));
  if (parts.length) ctx.stdout.write(parts.join('\n\n') + '\n');
  return 0;
}
