import { afterEach, describe, expect, it, vi } from 'vitest';
import { featuresRootPath } from '../features';
import { projectRoot } from '../project-root';
import { getProjectLabel } from '../project-label';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('projectRoot', () => {
  it('uses <features dir>/../.. when DASHBOARD_FEATURES_DIR is set', () => {
    vi.stubEnv('DASHBOARD_FEATURES_DIR', '/p/docs/features');
    expect(projectRoot()).toBe('/p');
  });

  it('uses cwd/../.. when unset (dashboard at <root>/plugin/dashboard)', () => {
    vi.stubEnv('DASHBOARD_FEATURES_DIR', '');
    vi.spyOn(process, 'cwd').mockReturnValue('/x/plugin/dashboard');
    expect(projectRoot()).toBe('/x');
  });
});

describe('consumers with the env var unset and cwd <x>/plugin/dashboard', () => {
  it('features dir is <root>/docs/features', () => {
    vi.stubEnv('DASHBOARD_FEATURES_DIR', '');
    vi.stubEnv('DASHBOARD_DEMO', '');
    vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-x/plugin/dashboard');
    expect(featuresRootPath()).toBe('/nonexistent-x/docs/features');
  });

  it('project label comes from the root basename', async () => {
    vi.stubEnv('DASHBOARD_FEATURES_DIR', '');
    vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-x/plugin/dashboard');
    delete (globalThis as { __projectLabel?: Promise<string> }).__projectLabel;
    expect(await getProjectLabel()).toBe('nonexistent-x');
    delete (globalThis as { __projectLabel?: Promise<string> }).__projectLabel;
  });
});
