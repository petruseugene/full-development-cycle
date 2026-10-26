/**
 * Loopback middleware contract (spec R15 / AC7). Pins:
 *   - which Host header values count as loopback (and which don't),
 *   - assertLoopback returns a 404 Response for non-loopback hosts,
 *     and null (pass-through) for loopback hosts.
 */
import { describe, it, expect } from 'vitest';
import { isLoopbackHost, assertLoopback } from '../loopback';

describe('isLoopbackHost', () => {
  it('returns true for 127.0.0.1', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
  });

  it('returns true for localhost', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
  });

  it('returns true for ::1', () => {
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('returns true for localhost:3737', () => {
    expect(isLoopbackHost('localhost:3737')).toBe(true);
  });

  it('returns false for a non-loopback IPv4 host', () => {
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe('assertLoopback', () => {
  it('returns null for a loopback Host header (pass-through)', () => {
    const req = new Request('http://127.0.0.1/api/agent/x', {
      headers: { host: '127.0.0.1:3737' },
    });
    expect(assertLoopback(req)).toBeNull();
  });

  it('returns a 404 Response for a non-loopback Host header', () => {
    const req = new Request('http://example.com/api/agent/x', {
      headers: { host: 'example.com' },
    });
    const res = assertLoopback(req);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(404);
  });
});
