import { describe, it, expect } from 'vitest';
import { parseTestReportMd } from '../parsers';

describe('parseTestReportMd visual-diff (AC29)', () => {
  for (const line of ['visual-diff: 3/4', 'visual-diff: screens — 3/4']) {
    it(`parses "${line}"`, () => {
      const r = parseTestReportMd(`---\nstatus: PASSED\n---\n${line}\n`);
      const v = r.visualDiffs ?? [];
      expect(v).toHaveLength(4);
      expect(v.filter((d) => d.status === 'pass')).toHaveLength(3);
    });
  }
});

describe('parseTestReportMd hyphenated screen ids', () => {
  it('keeps the full id and splits detail on spaced dash only', () => {
    const r = parseTestReportMd(
      '---\nstatus: FAILED\n---\n- [pass] lis-m2 @ web — ok 1.0s\n- [fail] home-375 @ web — --fail wraps\n',
    );
    expect(r.cases?.map((c) => c.name)).toEqual(['lis-m2 @ web', 'home-375 @ web']);
  });
});
