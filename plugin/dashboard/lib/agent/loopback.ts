/**
 * Loopback-only guard for the `/api/agent/*` routes (spec R15, AC7).
 *
 * The dashboard Agent SDK surface is single-user, local-only — the dev server
 * binds to 127.0.0.1 (see `package.json` scripts), and every `/api/agent/*`
 * handler calls `assertLoopback(request)` as its first line. A non-loopback
 * Host header earns a 404 (not 403) so the surface is indistinguishable from
 * a route that does not exist.
 *
 * This is the only auth layer in v1.
 */

const LOOPBACK_HOSTNAMES = new Set<string>(['127.0.0.1', 'localhost', '::1']);

/**
 * Strip an optional port suffix from a Host-header value and normalise IPv6
 * bracket form. Returns the bare hostname suitable for set lookup.
 *
 * Examples:
 *   "127.0.0.1:3737"    -> "127.0.0.1"
 *   "localhost"         -> "localhost"
 *   "[::1]:3737"        -> "::1"
 *   "[::1]"             -> "::1"
 *   "example.com:3737"  -> "example.com"
 */
function normaliseHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return trimmed;

  // IPv6 bracket form: "[::1]" or "[::1]:3737"
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing > 0) return trimmed.slice(1, closing);
    return trimmed;
  }

  // Bare IPv6 (no brackets) — a valid Host header would always bracket it
  // when a port is present, so any "::" form here has no port to strip.
  // We accept the looser bare form (e.g. "::1") for tolerance with curl/test
  // clients that may bypass the bracketing requirement.
  if (trimmed.includes('::')) return trimmed;

  // For IPv4 / hostname, the last ":" delimits the port.
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) return trimmed;
  return trimmed.slice(0, colon);
}

/**
 * Returns true iff `host` (the value of an HTTP Host header, with or without
 * a `:port` suffix) refers to a loopback address. `null`/empty input returns
 * false — a missing Host header is treated as non-loopback.
 */
export function isLoopbackHost(host: string | null): boolean {
  if (host == null) return false;
  const bare = normaliseHost(host);
  if (bare.length === 0) return false;
  return LOOPBACK_HOSTNAMES.has(bare);
}

/**
 * Drop-in guard for Next.js Route Handlers. Call this as the first statement
 * of every `/api/agent/*` handler. Returns a 404 `Response` (with an empty
 * body) when the request originated from a non-loopback host, else `null`.
 *
 * Usage:
 *
 *   export async function GET(request: Request) {
 *     const blocked = assertLoopback(request);
 *     if (blocked) return blocked;
 *     // …real handler logic…
 *   }
 */
export function assertLoopback(request: Request): Response | null {
  const host = request.headers.get('host');
  if (isLoopbackHost(host)) return null;
  return new Response(null, { status: 404 });
}
