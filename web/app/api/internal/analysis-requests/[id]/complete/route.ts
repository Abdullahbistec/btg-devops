import { NextRequest, NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/auth';
import { getAnalysisRequest, completeAnalysisRequest, failAnalysisRequest } from '@/lib/db';

/** Backs the MCP server's save_analysis tool. Body is either
 * { summary: string } on success or { error: string } on failure — the
 * routine calls this exactly once per request it picks up. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const request = await getAnalysisRequest(id);
  if (!request) {
    return NextResponse.json({ error: 'analysis request not found' }, { status: 404 });
  }

  const body = await req.json();
  const summary: string = body?.summary || '';
  const error: string = body?.error || '';

  if (error) {
    await failAnalysisRequest(id, error);
  } else if (summary) {
    await completeAnalysisRequest(id, summary);
  } else {
    return NextResponse.json({ error: 'summary or error is required' }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
