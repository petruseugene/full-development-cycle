/**
 * Log rotation helper for per-feature session log files (spec R43).
 *
 * `kill()` is intentionally non-destructive — it leaves the prior session's
 * `<featureId>.events.jsonl` and `<featureId>.stats.json` on disk so the user
 * can still scroll back through the historical record (see
 * `session-manager.ts`'s `kill()` JSDoc). The follow-up `POST /start` route
 * calls `rotateIfPresent(featureId)` before spawning a fresh session so the
 * new run begins with empty log files while the old ones are preserved under
 * an ISO-timestamped suffix.
 *
 * Suffix shape: `<featureId>.events.<isoTs>.jsonl` and
 * `<featureId>.stats.<isoTs>.json`, where `isoTs` is
 * `new Date().toISOString().replace(/[:.]/g, '-')`. Colons and dots are
 * replaced because some filesystems / shells treat them as special.
 *
 * Both files share the SAME `isoTs` per rotation call so a rotated pair can
 * be matched on disk.
 *
 * `ENOENT` is the no-op case: nothing to rotate means we simply return. Any
 * other rename failure is rethrown so the caller (the `/start` route) can
 * surface it as a 500 rather than silently start a fresh session on top of
 * stale logs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { assertSafeFeatureId } from './path-safety';

/**
 * Resolve the runtime sessions directory at call time so tests / future
 * configuration can override `process.cwd()` without baking a constant.
 * Mirrors the resolution used in `session-manager.ts` (`SESSIONS_DIR`).
 */
function sessionsDir(): string {
  return path.resolve(process.cwd(), '.runtime', 'sessions');
}

function eventsPath(dir: string, featureId: string): string {
  return path.join(dir, `${featureId}.events.jsonl`);
}

function statsPath(dir: string, featureId: string): string {
  return path.join(dir, `${featureId}.stats.json`);
}

function rotatedEventsPath(
  dir: string,
  featureId: string,
  isoTs: string,
): string {
  return path.join(dir, `${featureId}.events.${isoTs}.jsonl`);
}

function rotatedStatsPath(
  dir: string,
  featureId: string,
  isoTs: string,
): string {
  return path.join(dir, `${featureId}.stats.${isoTs}.json`);
}

/**
 * Narrow a `fs` error to one carrying a `code` field (the Node.js typing for
 * `NodeJS.ErrnoException`) without pulling in `@types/node` shims at the call
 * site.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

/**
 * Rename the previous session's log files for `featureId`, if they exist,
 * with the ISO-timestamped suffix described above. Missing files are a
 * silent no-op (ENOENT swallowed); other rename errors propagate.
 *
 * Side effects:
 *   - `dashboard/.runtime/sessions/<featureId>.events.jsonl`
 *       → `dashboard/.runtime/sessions/<featureId>.events.<isoTs>.jsonl`
 *   - `dashboard/.runtime/sessions/<featureId>.stats.json`
 *       → `dashboard/.runtime/sessions/<featureId>.stats.<isoTs>.json`
 *
 * Both renames share the same `isoTs` so a paired rotation is matchable on
 * disk. The helper does NOT touch `<featureId>.json` (the session-metadata
 * file) — that's owned by `sessionManager` and overwritten on every
 * `start()`.
 */
export async function rotateIfPresent(featureId: string): Promise<void> {
  // Defense in depth: even though the `/start` route validates featureId
  // before calling us, a future internal caller may not. Throwing here
  // means we never feed an untrusted segment into `path.join`.
  assertSafeFeatureId(featureId);
  const dir = sessionsDir();
  const isoTs = new Date().toISOString().replace(/[:.]/g, '-');

  await renameIfPresent(
    eventsPath(dir, featureId),
    rotatedEventsPath(dir, featureId, isoTs),
  );
  await renameIfPresent(
    statsPath(dir, featureId),
    rotatedStatsPath(dir, featureId, isoTs),
  );
}

async function renameIfPresent(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
}

/** Re-export grouped under a namespace for the route handler's call site. */
export const logRotation = { rotateIfPresent };
