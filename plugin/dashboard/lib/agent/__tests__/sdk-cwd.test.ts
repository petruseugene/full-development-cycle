import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { resolveSdkCwd } from '../session-manager';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveSdkCwd', () => {
  it('derives the project root from DASHBOARD_FEATURES_DIR', () => {
    vi.stubEnv('DASHBOARD_FEATURES_DIR', '/p/docs/features');
    expect(resolveSdkCwd()).toBe('/p');
  });

  it('falls back to cwd/../.. when the variable is unset', () => {
    vi.stubEnv('DASHBOARD_FEATURES_DIR', '');
    vi.spyOn(process, 'cwd').mockReturnValue('/x/plugin/dashboard');
    expect(resolveSdkCwd()).toBe(path.resolve('/x'));
  });
});
