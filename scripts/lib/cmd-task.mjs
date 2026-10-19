// dev-cycle task <n> status <S>
// dev-cycle task --all-from IMPL-DONE --to DONE
//
// Operates on the resolved tasks source (R38): plan.md, else spec.md with a
// `## Tasks` section. Only task list lines / headings change, never the
// spec frontmatter.

import path from 'node:path';
import { UsageError, parseCommandArgs, output, resolveFeatureDir, updateText } from './core.mjs';
import { appendHistory } from './history.mjs';
import { isOwnerTask, normalizeStatus, parsePlan, setTaskStatus, requireTasksSource, STATUSES } from './plan.mjs';

const USAGE = 'task <n> status <S> | task --all-from IMPL-DONE --to DONE';

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    options: { 'all-from': { type: 'string' }, to: { type: 'string' } },
    positionals: ['n?', 'verb?', 'status?'],
  });
  const dir = resolveFeatureDir(ctx, values);

  if (values['all-from'] !== undefined || values.to !== undefined) {
    if (args.n !== undefined) throw new UsageError(`unexpected argument '${args.n}' (usage: dev-cycle ${USAGE})`);
    const from = normalizeStatus(values['all-from'] ?? '');
    const to = normalizeStatus(values.to ?? '');
    if (from !== 'IMPL-DONE' || to !== 'DONE') {
      throw new UsageError(`only --all-from IMPL-DONE --to DONE is supported (usage: dev-cycle ${USAGE})`);
    }
    const file = requireTasksSource(dir).file;
    let changed = [];
    updateText(file, (before) => {
      const targets = parsePlan(before).filter((t) => t.status === 'IMPL-DONE' && !isOwnerTask(t));
      let text = before;
      changed = [];
      for (const t of targets) {
        text = setTaskStatus(text, t.n, 'DONE', { source: path.basename(file) });
        changed.push(t.n);
      }
      return text;
    });
    output(ctx, values, {
      text: changed.length ? `tasks flipped IMPL-DONE -> DONE: ${changed.join(', ')}` : 'no tasks flipped',
      data: { changed, from: 'IMPL-DONE', to: 'DONE' },
    });
    return 0;
  }

  if (args.n === undefined || args.verb !== 'status' || args.status === undefined) {
    throw new UsageError(`usage: dev-cycle ${USAGE}`);
  }
  if (!/^\d+$/.test(args.n)) throw new UsageError(`invalid task number '${args.n}'`);
  const n = Number(args.n);
  const status = normalizeStatus(args.status);
  if (!status) throw new UsageError(`unknown status '${args.status}' (expected one of ${STATUSES.join(', ')})`);
  const file = requireTasksSource(dir).file;
  let prev; let owner = false;
  updateText(file, (before) => {
    const t = parsePlan(before).find((x) => x.n === n);
    prev = t?.status; owner = Boolean(t) && isOwnerTask(t);
    return setTaskStatus(before, n, status, { source: path.basename(file) });
  });
  if (owner && status === 'DONE' && prev !== 'DONE') {
    appendHistory(dir, { phase: `owner.task=${n}`, subagent: 'owner', status: 'DONE', model: 'n/a', executor: 'cli' });
  }
  output(ctx, values, { text: `task ${n} status ${status}`, data: { task: n, status } });
  return 0;
}
