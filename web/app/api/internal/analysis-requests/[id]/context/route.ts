import { NextRequest, NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/auth';
import { getAnalysisRequest } from '@/lib/db';
import { buildAuditContext } from '@/lib/analysisContext';

/** Backs the MCP server's get_audit_data tool — via buildAuditContext(),
 * kept as its own function rather than inlined here. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const request = await getAnalysisRequest(id);
  if (!request) {
    return NextResponse.json({ error: 'analysis request not found' }, { status: 404 });
  }
  const context = await buildAuditContext(request.audit_id, request.scope);
  return NextResponse.json({ audit_id: request.audit_id, scope: request.scope, context });
}
