import { NextRequest, NextResponse } from 'next/server';
import { getAnalysisRequest } from '@/lib/db';
import { isAuthenticatedRequest } from '@/lib/auth';

/** Polled by the dashboard while an analysis request is pending. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const request = await getAnalysisRequest(params.id);
  if (!request) {
    return NextResponse.json({ error: 'analysis request not found' }, { status: 404 });
  }
  return NextResponse.json(request);
}
