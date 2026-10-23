import { describe, it, expect } from 'vitest';
import { splitTopLevel, parseAcceptanceItems, parseFileItem, parseStepItems } from '../task-fields';
import { parsePlanMd } from '../parsers';

describe('splitTopLevel', () => {
  it('ignores separators inside parentheses', () => {
    expect(splitTopLevel('AC1, AC2 (R1, R2, R3)')).toEqual(['AC1', 'AC2 (R1, R2, R3)']);
  });
  it('ignores separators inside backticks and brackets', () => {
    expect(splitTopLevel('`a,b.ts`, c[1,2].ts')).toEqual(['`a,b.ts`', 'c[1,2].ts']);
  });
  it('splits on semicolons', () => {
    expect(splitTopLevel('a; b (x; y); c')).toEqual(['a', 'b (x; y)', 'c']);
  });
  it('survives unbalanced closers', () => {
    expect(splitTopLevel('a), b')).toEqual(['a)', 'b']);
  });
});

describe('parseAcceptanceItems', () => {
  it('handles bulleted multi-line blocks', () => {
    const raw = '- AC3: first, with comma\n  continued line\n- AC4 (R1, R2)\n';
    expect(parseAcceptanceItems(raw)).toEqual(['AC3: first, with comma continued line', 'AC4 (R1, R2)']);
  });
  it('splits plain lines at top level', () => {
    expect(parseAcceptanceItems('AC1, AC2\nAC3')).toEqual(['AC1', 'AC2', 'AC3']);
  });
  it('returns [] for empty', () => {
    expect(parseAcceptanceItems(undefined)).toEqual([]);
  });
});

describe('parseFileItem', () => {
  it('splits path and note, dropping outer parens', () => {
    expect(parseFileItem('`scripts/lib/core.mjs` (modify: `featuresRoot` ~l.205, `locateFeature` ~l.226)')).toEqual({
      path: 'scripts/lib/core.mjs',
      note: 'modify: `featuresRoot` ~l.205, `locateFeature` ~l.226',
    });
  });
  it('handles bare paths and plain annotations', () => {
    expect(parseFileItem('src/a.ts (new)')).toEqual({ path: 'src/a.ts', note: 'new' });
    expect(parseFileItem('`src/b.ts`')).toEqual({ path: 'src/b.ts', note: '' });
  });
});

describe('parseStepItems', () => {
  it('keeps checkbox state', () => {
    expect(parseStepItems('\n- [ ] one `x`\n- [x] two\n')).toEqual([
      { text: 'one `x`', done: false },
      { text: 'two', done: true },
    ]);
  });
});

const PLAN = `# Plan

- [TODO] **Task 1** (backend): Worktree core

### Task 1: Worktree core

Resolve the feature root from the worktree, using \`git rev-parse\`.

Second paragraph with more detail that is long enough to matter.

**Files:** \`scripts/lib/core.mjs\` (modify: \`featuresRoot\` ~l.205, \`locateFeature\` ~l.226), \`scripts/test/core-worktree.test.mjs\` (new)
**Acceptance:** AC1, AC2 (R1, R2, R3)
**Steps:**
- [ ] write the test
- [x] run \`node --test\`
`;

describe('parsePlanMd Files/Acceptance/Steps', () => {
  const t = parsePlanMd(PLAN)[0];
  it('keeps parenthesised annotations in one file item', () => {
    expect(t.files).toHaveLength(2);
    expect(parseFileItem(t.files![0]).path).toBe('scripts/lib/core.mjs');
    expect(parseFileItem(t.files![1])).toEqual({ path: 'scripts/test/core-worktree.test.mjs', note: 'new' });
  });
  it('parses acceptance', () => {
    expect(parseAcceptanceItems(t.acceptance)).toEqual(['AC1', 'AC2 (R1, R2, R3)']);
  });
  it('exposes steps and full description', () => {
    expect(t.stepItems).toEqual([
      { text: 'write the test', done: false },
      { text: 'run `node --test`', done: true },
    ]);
    expect(t.fullDescription).toContain('Second paragraph');
    expect(t.fullDescription).toContain('`git rev-parse`');
    expect(t.fullDescription).not.toContain('Files');
    expect(t.fullDescription).not.toContain('write the test');
  });
});
