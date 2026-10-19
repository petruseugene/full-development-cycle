import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlanMd } from '../parsers';

function loadStrictRe(): RegExp {
  const src = readFileSync(
    join(__dirname, '../../app/api/features/[id]/tasks/route.ts'),
    'utf8',
  );
  const m = src.match(/STRICT_TASK_LINE_RE =\s*(\/.+\/);/);
  if (!m) throw new Error('STRICT_TASK_LINE_RE not found');
  return new Function(`return ${m[1]}`)() as RegExp;
}

const NEW_LINES = [
  '- [IMPL-DONE] **Task 1** (backend): a',
  '- [IN REVIEW] **Task 2** (frontend): b',
];

describe('IMPL-DONE / IN REVIEW statuses', () => {
  it('parse to IN_TESTING', () => {
    const tasks = parsePlanMd(`## Tasks\n\n${NEW_LINES.join('\n')}\n`);
    expect(tasks.map((t) => [t.index, t.status])).toEqual([
      [1, 'IN_TESTING'],
      [2, 'IN_TESTING'],
    ]);
  });

  it('existing statuses unchanged', () => {
    const md = [
      '- [TODO] **Task 1** (backend): a',
      '- [IN PROGRESS] **Task 2** (backend): b',
      '- [IN TESTING] **Task 3** (backend): c',
      '- [BLOCKED] **Task 4** (backend): d',
      '- [DONE] **Task 5** (backend): e',
    ].join('\n');
    expect(parsePlanMd(md).map((t) => t.status)).toEqual([
      'TODO',
      'IN_PROGRESS',
      'IN_TESTING',
      'BLOCKED',
      'DONE',
    ]);
  });

  it('STRICT_TASK_LINE_RE matches new lines; next number is 3', () => {
    const re = loadStrictRe();
    const nums = NEW_LINES.map((l) => Number(re.exec(l)?.[1]));
    expect(nums).toEqual([1, 2]);
    expect(Math.max(...nums) + 1).toBe(3);
  });
});
