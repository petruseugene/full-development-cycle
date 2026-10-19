/**
 * GET /api/agent-status — always 200 `{ enabled, mode, reason }`.
 *
 * Lives outside `/api/agent/**` (which 404s when the agent is off) and never
 * imports `lib/agent/*` or the Agent SDK. Never exposes key material.
 */
import { NextResponse } from 'next/server';

import { getAgentStatus } from '@/lib/agent-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { enabled, mode, reason } = await getAgentStatus();
  return NextResponse.json(
    { enabled, mode, reason },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
