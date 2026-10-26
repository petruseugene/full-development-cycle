import { NextResponse } from 'next/server';
import { loadFeatures } from '@/lib/features';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const features = await loadFeatures();
  const feature = features.find((f) => f.id === params.id);
  if (!feature) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(feature, { headers: { 'Cache-Control': 'no-store' } });
}
