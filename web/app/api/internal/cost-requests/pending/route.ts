import { NextRequest, NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/auth';
import { listPendingCostFetchRequests } from '@/lib/db';

/** Backs the MCP server's list_pending_cost_requests tool (cmd/mcp.go
 * --http). Bearer-token guarded via MCP_INTERNAL_TOKEN, same as the
 * analysis-requests internal routes. */
export async function GET(req: NextRequest) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const pending = await listPendingCostFetchRequests();
  return NextResponse.json(pending.map(r => ({ id: r.id, subscription_id: r.subscription_id, requested_at: r.requested_at })));
}
