import { NextRequest, NextResponse } from 'next/server';
import { listAudits } from '@/lib/db';
import { isAuthenticatedRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const subId = req.nextUrl.searchParams.get('subscription_id') ?? undefined;
    const audits = await listAudits(subId);
    return NextResponse.json(audits);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
