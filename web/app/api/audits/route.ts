import { NextRequest, NextResponse } from 'next/server';
import { listAudits } from '@/lib/db';
import { isAuthenticatedRequest } from '@/lib/auth';
import { apiError } from '@/lib/api-error';

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const subId = req.nextUrl.searchParams.get('subscription_id') ?? undefined;
    const audits = await listAudits(subId);
    return NextResponse.json(audits);
  } catch (e) {
    return apiError(e, 'GET /api/audits');
  }
}
