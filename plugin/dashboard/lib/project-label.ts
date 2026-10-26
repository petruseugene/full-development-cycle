/**
 * Server-only project label for the top bar: `owner/repo` from the git
 * `origin` remote, else the project root folder's basename. Never returns an
 * absolute path or URL credentials.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { projectRoot } from './project-root';

/** Parse a git remote URL (https, ssh://, scp-like) to `owner/repo`, or null. */
export function parseRemoteSlug(remote: string | null | undefined): string | null {
  const raw = (remote ?? '').trim();
  if (!raw) return null;
  let p: string;
  const scp = /^[^/@\s]+@[^/:\s]+:(?!\/)(.+)$/.exec(raw); // git@host:owner/repo.git
  if (scp) {
    p = scp[1];
  } else {
    try {
      const u = new URL(raw);
      // file:// and other non-network remotes would leak local path segments.
      if (!/^(?:https?|ssh|git):$/.test(u.protocol)) return null;
      p = decodeURIComponent(u.pathname); // drops user:token@ implicitly
    } catch {
      return null;
    }
  }
  const parts = p
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function projectLabelFrom(remote: string | null | undefined, root: string): string {
  return parseRemoteSlug(remote) ?? (path.basename(root) || 'project');
}

function gitOrigin(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['config', '--get', 'remote.origin.url'],
        { cwd, timeout: 2000, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

const G = globalThis as unknown as { __projectLabel?: Promise<string> };

export function getProjectLabel(): Promise<string> {
  if (!G.__projectLabel) {
    const root = projectRoot();
    G.__projectLabel = gitOrigin(root).then((r) => projectLabelFrom(r, root));
  }
  return G.__projectLabel;
}
