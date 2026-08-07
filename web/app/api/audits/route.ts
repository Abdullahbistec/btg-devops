import { NextRequest, NextResponse } from 'next/server';
import { listAudits } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const subId = req.nextUrl.searchParams.get('subscription_id') ?? undefined;
    const audits = listAudits(subId);
    return NextResponse.json(audits);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
