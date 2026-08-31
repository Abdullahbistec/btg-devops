import { NextRequest, NextResponse } from 'next/server';
import { isInternalServiceRequest } from '@/lib/auth';
import { getCostFetchRequest, completeCostFetchRequest, failCostFetchRequest } from '@/lib/db';
import { refreshCostSnapshot, backfillCostHistory } from '@/lib/costManagement';

/** Backs the MCP server's fetch_cost_data tool. This is the ONLY place that
 * actually calls Azure Cost Management live — Azure credentials never leave
 * this server; the MCP server (and the Claude routine calling it) only ever
 * sees the request id and the outcome, never a token or secret.
 *
 * A request's `type` (set at creation — see /api/cost-requests) decides
 * which of two very different jobs runs here: 'refresh' is the normal live
 * MonthToDate fetch; 'backfill' is a one-time historical fill of past
 * calendar months (backfillCostHistory), used to seed real Billing History
 * data instead of waiting for it to accumulate day by day. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const request = await getCostFetchRequest(params.id);
  if (!request) {
    return NextResponse.json({ error: 'cost fetch request not found' }, { status: 404 });
  }

  try {
    if (request.type === 'backfill') {
      const { saved, skipped, errors } = await backfillCostHistory(request.subscription_id, request.months ?? 6);
      await completeCostFetchRequest(params.id, errors.length ? `Backfilled ${saved} month(s), ${skipped} already had data, ${errors.length} failed: ${errors.join('; ')}` : undefined);
      return NextResponse.json({ ok: true, backfilled: saved, skipped, errors });
    }

    const payload = await refreshCostSnapshot(request.subscription_id);
    await completeCostFetchRequest(params.id);
    return NextResponse.json({
      ok: true,
      subscription: payload.subscription.name,
      totalCost: payload.totalCost,
      currency: payload.currency,
    });
  } catch (e) {
    const message = (e as Error).message;
    await failCostFetchRequest(params.id, message);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
