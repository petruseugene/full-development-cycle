/**
 * `assertSafeFeatureId` contract — pins the rule that every featureId
 * crossing the `/api/agent/*` boundary be a path-safe slug before it
 * is interpolated into a runtime filesystem path. Covers the
 * BLOCKER from cycle-1 review (path traversal via `..%2F..%2Fpwn`).
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { assertSafeFeatureId } from '../path-safety';

describe('assertSafeFeatureId — accepts', () => {
  it.each([
    'feat-chat-control-panel',
    'feat_with_underscores',
    'feat.with.dots',
    'ABC123',
    'a',
    '2026-05-15-22h-52m-chat-control-panel',
    'mixed.Case_with-1.2.3',
  ])('returns %s unchanged', (id) => {
    expect(assertSafeFeatureId(id)).toBe(id);
  });
});

describe('assertSafeFeatureId — rejects', () => {
  const INVALID = 'invalid_feature_id';

  it('rejects empty string', () => {
    expect(() => assertSafeFeatureId('')).toThrow(INVALID);
  });

  it.each([
    ['..', 'bare traversal'],
    ['../foo', 'leading traversal'],
    ['foo/../bar', 'embedded traversal'],
    ['foo..bar', 'double-dot anywhere'],
  ])('rejects %s (%s)', (id) => {
    expect(() => assertSafeFeatureId(id)).toThrow(INVALID);
  });

  it.each([
    ['foo/bar', 'forward slash'],
    ['/abs', 'leading forward slash'],
    ['foo\\bar', 'backslash'],
    ['foo\\..\\bar', 'mixed windows traversal'],
  ])('rejects %s (%s)', (id) => {
    expect(() => assertSafeFeatureId(id)).toThrow(INVALID);
  });

  it('rejects NUL injection (foo\\0bar)', () => {
    expect(() => assertSafeFeatureId('foo\0bar')).toThrow(INVALID);
  });

  it.each([
    ['.hidden', 'leading dot — dotfile'],
    ['.', 'single dot'],
    ['.gitignore', 'dotfile name'],
  ])('rejects %s (%s)', (id) => {
    expect(() => assertSafeFeatureId(id)).toThrow(INVALID);
  });

  it.each([
    ['foo bar', 'space'],
    ['foo\tbar', 'tab'],
    ['foo\nbar', 'newline'],
    ['foo:bar', 'colon'],
    ['foo;bar', 'semicolon'],
    ['foo$bar', 'dollar'],
    ['foo*bar', 'glob'],
    ['foo?bar', 'glob'],
    ['foo%2fbar', 'literal percent-encoded slash'],
    ['foo+bar', 'plus'],
    ['café', 'unicode'],
  ])('rejects %s (%s)', (id) => {
    expect(() => assertSafeFeatureId(id)).toThrow(INVALID);
  });
});

describe('assertSafeFeatureId — invariant', () => {
  // The whole point: a sanitised id MUST resolve under the runtime root.
  const runtimeDir = path.resolve('/var/runtime/sessions');

  it.each([
    'feat-x',
    'feat_y',
    'feat.z',
    'A1.B2-C3',
    'a',
  ])('path.resolve(runtimeDir, %s + .json) stays under runtimeDir', (id) => {
    const safe = assertSafeFeatureId(id);
    const resolved = path.resolve(runtimeDir, `${safe}.json`);
    expect(resolved.startsWith(runtimeDir + path.sep)).toBe(true);
  });

  it('hand-traced: ../../pwn would have escaped (control case)', () => {
    // Sanity check — confirm the unsanitised path WOULD escape, so the
    // test above is meaningful. We never let the unsafe id reach
    // path.resolve in production; this is documentation.
    const unsafe = '../../pwn';
    const resolved = path.resolve(runtimeDir, `${unsafe}.json`);
    expect(resolved.startsWith(runtimeDir + path.sep)).toBe(false);
    // And the guard rejects it.
    expect(() => assertSafeFeatureId(unsafe)).toThrow('invalid_feature_id');
  });
});
