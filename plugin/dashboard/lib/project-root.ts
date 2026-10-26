import path from 'node:path';

/**
 * The one place the dashboard derives the project root.
 * With DASHBOARD_FEATURES_DIR set the root is `<dir>/../..` (`<root>/docs/features`);
 * otherwise the dashboard runs at `<root>/plugin/dashboard`, so the root is `cwd/../..`.
 */
export function projectRoot(): string {
  const env = process.env.DASHBOARD_FEATURES_DIR;
  if (env && env.trim()) return path.resolve(env, '..', '..');
  return path.resolve(process.cwd(), '..', '..');
}
