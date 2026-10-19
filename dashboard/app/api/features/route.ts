import { assertSameOrigin } from '@/lib/csrf';
import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildSnapshot } from '@/lib/features';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const snapshot = await buildSnapshot();
  return NextResponse.json(snapshot, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * Resolve the pending-features log path.
 *
 * Per spec open question #1 + plan Task 6: when `DASHBOARD_FEATURES_DIR` is set
 * we write `${DASHBOARD_FEATURES_DIR}/pending-features.log`. Otherwise we fall
 * back to `<repo-root>/pending-features.log`, where repo-root is the parent of
 * the `dashboard/` cwd (mirroring the resolution used inside lib/features.ts).
 */
function pendingFeaturesLogPath(): string {
  const env = process.env.DASHBOARD_FEATURES_DIR;
  if (env && env.trim()) return path.join(path.resolve(env), 'pending-features.log');
  const repoRoot = path.resolve(process.cwd(), '..');
  return path.join(repoRoot, 'pending-features.log');
}

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req, { requireJson: true });
  if (csrf) return csrf;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const raw = (body as { prompt?: unknown })?.prompt;
  if (typeof raw !== 'string') {
    return NextResponse.json({ error: 'prompt must be a string' }, { status: 400 });
  }
  const prompt = raw.trim();
  if (prompt.length === 0) {
    return NextResponse.json({ error: 'prompt must not be empty' }, { status: 400 });
  }

  const line = JSON.stringify({ ts: new Date().toISOString(), prompt }) + '\n';

  try {
    await fs.appendFile(pendingFeaturesLogPath(), line, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
