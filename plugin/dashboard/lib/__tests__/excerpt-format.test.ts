import { describe, it, expect } from 'vitest';
import { parsePlanMd } from '../parsers';
import { cleanExcerpt, truncateWords } from '../excerpt';
import { formatTokens } from '../format';

const plan = (body: string) =>
  `## Tasks\n\n- [TODO] **Task 1** (frontend): Thing\n\n## Task details\n\n### Task 1: Thing\n\n${body}\n`;

describe('plan description excerpt', () => {
  it('skips the metadata paragraph and uses the real description', () => {
    const t = parsePlanMd(plan('**Tag:** frontend\n**Touches:** `a/**`\n**Depends on:** none\n\nAdd a quick-add button to the board header.\n\n**Files:** a.ts'));
    expect(t[0].description).toBe('Add a quick-add button to the board header.');
  });
  it('skips horizontal rules', () => {
    const t = parsePlanMd(plan('---\n\nReal text here.'));
    expect(t[0].description).toBe('Real text here.');
    expect(cleanExcerpt('---\n***\ntext')).toBe('text');
  });
  it('truncates on a word boundary with an ellipsis', () => {
    const long = 'alpha beta gamma '.repeat(30).trim();
    const t = parsePlanMd(plan(long));
    const d = t[0].description!;
    expect(d.length).toBeLessThanOrEqual(240);
    expect(d.endsWith('…')).toBe(true);
    expect(d.slice(0, -1).split(' ').every((w) => ['alpha', 'beta', 'gamma'].includes(w))).toBe(true);
  });
  it('truncateWords leaves short text alone', () => {
    expect(truncateWords('short', 240)).toBe('short');
  });
});

describe('formatTokens', () => {
  it('uses k below 1000k and M above', () => {
    expect(formatTokens(28.44)).toBe('28.4k');
    expect(formatTokens(0)).toBe('0.0k');
    expect(formatTokens(999.9)).toBe('999.9k');
    expect(formatTokens(1000)).toBe('1.0M');
    expect(formatTokens(24174)).toBe('24.2M');
  });
});
