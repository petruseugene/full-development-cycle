import { describe, it, expect } from 'vitest';
import { parseSpecStatus } from '../parsers';

describe('parseSpecStatus extra cases', () => {
  it('[DONE] -> DONE', () => {
    expect(parseSpecStatus('---\nstatus: [DONE]\n---\n')).toBe('DONE');
  });
  it('unbracketed status is returned trimmed', () => {
    expect(parseSpecStatus('---\nstatus:   DONE  \n---\n')).toBe('DONE');
  });
  it('quoted bracketed status', () => {
    expect(parseSpecStatus('---\nstatus: "[IN REVIEW]"\n---\n')).toBe('IN REVIEW');
  });
  it('empty string -> null', () => {
    expect(parseSpecStatus('')).toBeNull();
  });
  it('empty status value -> null', () => {
    expect(parseSpecStatus('---\nstatus: \n---\n')).toBeNull();
  });
  it('malformed YAML never throws', () => {
    expect(() => parseSpecStatus('---\nstatus: [TODO\n: : :\n---\n')).not.toThrow();
  });
  it('spec with real frontmatter shape (extra keys) -> TODO', () => {
    const raw = '---\nfeature: per-skill-model-selection\ncreated: 2026-10-08 11:16\nstatus: [TODO]\nflow: feature\n---\n\n# Spec';
    expect(parseSpecStatus(raw)).toBe('TODO');
  });
});
