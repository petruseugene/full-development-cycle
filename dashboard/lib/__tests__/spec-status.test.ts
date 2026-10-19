import { describe, it, expect } from 'vitest';
import { parseSpecStatus } from '../parsers';

describe('parseSpecStatus', () => {
  it('(a) [TODO] -> TODO', () => {
    expect(parseSpecStatus('---\nfeature: x\nstatus: [TODO]\n---\n# Spec')).toBe('TODO');
  });
  it('(b) [IN PROGRESS] -> IN PROGRESS', () => {
    expect(parseSpecStatus('---\nstatus: [IN PROGRESS]\n---\nbody')).toBe('IN PROGRESS');
  });
  it('(c) no frontmatter -> null', () => {
    expect(parseSpecStatus('# Just a heading\nstatus: [TODO]')).toBeNull();
  });
  it('(d) null -> null', () => {
    expect(parseSpecStatus(null)).toBeNull();
  });
  it('(e) frontmatter without status -> null', () => {
    expect(parseSpecStatus('---\nfeature: x\n---\nbody')).toBeNull();
  });
});
