import { NextRequest, NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/auth';
import { listPendingAnalysisRequests } from '@/lib/db';

/** Backs the MCP server's list_pending_requests tool (cmd/mcp.go --http).
 * Bearer-token guarded via MCP_INTERNAL_TOKEN — this is a different secret
 * from user login sessions, since the caller is a service, not a browser. */
export async function GET(req: NextRequest) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const pending = listPendingAnalysisRequests();
  return NextResponse.json(pending.map(r => ({ id: r.id, audit_id: r.audit_id, scope: r.scope, requested_at: r.requested_at })));
}
