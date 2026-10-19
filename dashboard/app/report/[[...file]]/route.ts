import { promises as fs } from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

// Intentionally unauthenticated: the dashboard is a local developer tool bound
// to 127.0.0.1, like every other dashboard route. Only fixed-name files from
// .dev-cycle/report/ are served (NAME_RE: no slashes, one segment).

const NAME_RE = /^[A-Za-z0-9._-]+\.(html|json)$/;
const CSP = "default-src 'none'; style-src 'unsafe-inline'";
const NOT_FOUND = 'No report yet — run `node <plugin>/scripts/dev-cycle.mjs report`';

// Same resolution as lib/features.ts: features dir, then project = two levels up.
function projectRoot(): string {
  const env = process.env.DASHBOARD_FEATURES_DIR;
  const featuresDir =
    env && env.trim() ? path.resolve(env) : path.join(path.resolve(process.cwd(), '..'), 'docs', 'features');
  return path.resolve(featuresDir, '..', '..');
}

function notFound(): Response {
  return new Response(NOT_FOUND, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export async function GET(
  req: Request,
  { params }: { params: { file?: string[] } | Promise<{ file?: string[] }> },
): Promise<Response> {
  const { file } = await params;
  const segs = file ?? [];
  if (segs.length > 1) return notFound();
  // `/report` has no file: redirect so the index's relative `./<folder>.html`
  // links resolve under /report/. `/report/` is normalised to `/report` by Next
  // and lands here too, then goes to /report/index.html (a file, so no loop).
  if (segs.length === 0) {
    return new Response(null, { status: 308, headers: { location: new URL('/report/index.html', req.url).pathname } });
  }
  let name = segs[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    return notFound();
  }
  if (!NAME_RE.test(name)) return notFound();
  try {
    const body = await fs.readFile(path.join(projectRoot(), '.dev-cycle', 'report', name));
    if (name.endsWith('.json')) {
      return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' } });
    }
    return new Response(body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return notFound();
  }
}
