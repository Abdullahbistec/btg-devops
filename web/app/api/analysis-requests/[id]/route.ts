import { NextRequest, NextResponse } from 'next/server';
import { getAnalysisRequest } from '@/lib/db';

/** Polled by the dashboard while an analysis request is pending. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const request = getAnalysisRequest(params.id);
  if (!request) {
    return NextResponse.json({ error: 'analysis request not found' }, { status: 404 });
  }
  return NextResponse.json(request);
}
