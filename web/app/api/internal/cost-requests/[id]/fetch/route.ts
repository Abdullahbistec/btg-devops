import { NextRequest, NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/auth';
import { getCostFetchRequest, completeCostFetchRequest, failCostFetchRequest } from '@/lib/db';
import { refreshCostSnapshot } from '@/lib/costManagement';

/** Backs the MCP server's fetch_cost_data tool. This is the ONLY place that
 * actually calls Azure Cost Management live — Azure credentials never leave
 * this server; the MCP server (and the Claude routine calling it) only ever
 * sees the request id and the outcome, never a token or secret. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const request = getCostFetchRequest(params.id);
  if (!request) {
    return NextResponse.json({ error: 'cost fetch request not found' }, { status: 404 });
  }

  try {
    const payload = await refreshCostSnapshot(request.subscription_id);
    completeCostFetchRequest(params.id);
    return NextResponse.json({
      ok: true,
      subscription: payload.subscription.name,
      totalCost: payload.totalCost,
      currency: payload.currency,
    });
  } catch (e) {
    const message = (e as Error).message;
    failCostFetchRequest(params.id, message);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
