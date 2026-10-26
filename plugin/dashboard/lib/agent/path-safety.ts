/**
 * Path-safety guard for the per-feature Agent SDK surface.
 *
 * The `featureId` arriving at `/api/agent/[featureId]/...` is sourced
 * directly from a URL segment. Several call sites interpolate it into
 * a filesystem path under `dashboard/.runtime/sessions/`:
 *
 *   - `session-manager.ts`  metaPath / eventsPath / statsPath
 *   - `log-rotation.ts`     rename source + destination
 *
 * Without validation, a request to `/api/agent/..%2F..%2Fpwn/start`
 * lands as `featureId === '../../pwn'` and lets the manager write
 * `dashboard/.runtime/sessions/../../pwn.json` — escaping the runtime
 * root. The loopback Host-header guard does NOT mitigate this: any
 * local script or simple-CORS form POST satisfies the Host check.
 *
 * `assertSafeFeatureId(id)` is the single chokepoint. Route handlers
 * call it right after `assertLoopback`; manager methods call it at the
 * top of every path-deriving operation (defense in depth — future
 * internal callers don't have to know the rule).
 *
 * Reject any input that:
 *   - is empty
 *   - contains `/`, `\`, NUL, or the `..` sequence
 *   - begins with `.` (would silently create dotfiles under .runtime)
 *   - contains any character outside `[A-Za-z0-9_.-]`
 *
 * Reasoning: the allowlist is the primary defence; the explicit
 * `/`, `\\`, `\0`, `..`, leading-dot checks are belt-and-braces and
 * give the test suite (and any future reviewer) clear named cases.
 *
 * Invariant: for every input `id` that passes,
 *   `path.resolve(runtimeDir, sanitisedId + '.json').startsWith(runtimeDir)`
 * holds — there is no way to escape the parent directory.
 */

/**
 * The single-character allowlist for a sanitised featureId. ASCII
 * letters, digits, underscore, dot, hyphen. No slashes, no NUL,
 * no whitespace, no unicode normalisation surprises.
 */
const SAFE_FEATURE_ID_RE = /^[A-Za-z0-9_.\-]+$/;

/**
 * Validate `id` is safe to interpolate into a filesystem path under
 * the `dashboard/.runtime/sessions/` runtime root.
 *
 * Throws `Error('invalid_feature_id')` on any rejection; returns the
 * input unchanged on success so callers can write:
 *
 *   const featureId = assertSafeFeatureId(params.featureId);
 *
 * Route handlers catch the throw and translate to
 * `400 { error: 'invalid_feature_id' }`. Internal manager calls let
 * the throw propagate — the surface is invoked through the routes,
 * so a thrown error here is by definition a programmer / future
 * regression issue.
 */
export function assertSafeFeatureId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('invalid_feature_id');
  }
  // Explicit traversal / separator checks before the allowlist so a
  // future allowlist tweak (e.g. permitting `+`) can never silently
  // re-open the escape vector.
  if (
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('\0') ||
    id.includes('..')
  ) {
    throw new Error('invalid_feature_id');
  }
  if (id.startsWith('.')) {
    throw new Error('invalid_feature_id');
  }
  if (!SAFE_FEATURE_ID_RE.test(id)) {
    throw new Error('invalid_feature_id');
  }
  return id;
}
