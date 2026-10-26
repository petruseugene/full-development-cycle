// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseRemoteSlug, projectLabelFrom } from '@/lib/project-label';

describe('parseRemoteSlug', () => {
  it('parses https remotes', () => {
    expect(parseRemoteSlug('https://github.com/petruseugene/full-development-cycle.git')).toBe(
      'petruseugene/full-development-cycle',
    );
    expect(parseRemoteSlug('https://github.com/o/r')).toBe('o/r');
  });
  it('parses scp-like and ssh:// remotes', () => {
    expect(parseRemoteSlug('git@github.com:o/r.git')).toBe('o/r');
    expect(parseRemoteSlug('ssh://git@github.com/o/r.git')).toBe('o/r');
  });
  it('never leaks embedded credentials', () => {
    const s = parseRemoteSlug('https://user:ghp_SECRET@github.com/o/r.git');
    expect(s).toBe('o/r');
    expect(s).not.toContain('SECRET');
  });
  it('returns null for file:// and local-path remotes so the basename fallback applies', () => {
    expect(parseRemoteSlug('file:///Users/me/repos/proj.git')).toBeNull();
    expect(parseRemoteSlug('/Users/me/repos/proj.git')).toBeNull();
    expect(projectLabelFrom('file:///Users/me/repos/proj.git', '/x/my-proj')).toBe('my-proj');
  });
  it('returns null for empty or unparseable input', () => {
    expect(parseRemoteSlug('')).toBeNull();
    expect(parseRemoteSlug(null)).toBeNull();
    expect(parseRemoteSlug('not a url')).toBeNull();
  });
});

describe('projectLabelFrom', () => {
  it('falls back to the root basename when there is no remote', () => {
    expect(projectLabelFrom(null, '/Users/x/dev/my-proj')).toBe('my-proj');
  });
  it('prefers owner/repo', () => {
    expect(projectLabelFrom('git@github.com:o/r.git', '/a/b')).toBe('o/r');
  });
});
