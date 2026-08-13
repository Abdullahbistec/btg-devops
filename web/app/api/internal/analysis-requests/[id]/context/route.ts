import { NextRequest, NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/auth';
import { getAnalysisRequest } from '@/lib/db';
import { buildAuditContext } from '@/lib/analysisContext';

/** Backs the MCP server's get_audit_data tool — same context text the
 * synchronous Gemini assistant already builds (buildAuditContext), reused
 * rather than re-derived, so the two analysis paths can't drift apart. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const request = getAnalysisRequest(params.id);
  if (!request) {
    return NextResponse.json({ error: 'analysis request not found' }, { status: 404 });
  }
  const context = buildAuditContext(request.audit_id, request.scope);
  return NextResponse.json({ audit_id: request.audit_id, scope: request.scope, context });
}
