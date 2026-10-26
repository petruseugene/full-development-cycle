import { NextResponse } from 'next/server';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(hostWithPort: string): string {
  const h = hostWithPort.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/**
 * CSRF guard for state-changing routes. Browsers always attach `Origin` (and
 * `Sec-Fetch-Site`) to cross-origin POSTs, so a hostile page cannot forge a
 * same-origin request. Non-browser callers (curl, tests) send neither header
 * and are allowed. With `requireJson`, a `text/plain` / form "simple request"
 * body is rejected as well (415).
 *
 * Returns a Response to short-circuit with, or null when the request passes.
 */
export function assertSameOrigin(
  req: Request,
  opts: { requireJson?: boolean } = {},
): NextResponse | null {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return NextResponse.json({ error: 'cross-origin request rejected' }, { status: 403 });
  }
  const origin = req.headers.get('origin');
  if (origin !== null) {
    let ohost = '';
    try {
      ohost = new URL(origin).host.toLowerCase();
    } catch {
      /* opaque origin ("null") falls through to rejection */
    }
    const host = (req.headers.get('host') ?? '').toLowerCase();
    if (!ohost || ohost !== host || !LOOPBACK.has(hostnameOf(ohost))) {
      return NextResponse.json({ error: 'cross-origin request rejected' }, { status: 403 });
    }
  }
  if (opts.requireJson) {
    const ct = (req.headers.get('content-type') ?? '').toLowerCase();
    if (!/^application\/json\s*(;|$)/.test(ct)) {
      return NextResponse.json({ error: 'content-type must be application/json' }, { status: 415 });
    }
  }
  return null;
}
