import { NextRequest, NextResponse } from 'next/server';
import {
  getDB, getSubscription, createCostFetchRequest, getPendingCostFetchRequestFor,
  completeCostFetchRequest, failCostFetchRequest,
} from '@/lib/db';
import { refreshCostSnapshot } from '@/lib/costManagement';

/** Creates a cost-refresh request and processes it immediately, in-process —
 * no MCP server or scheduled Claude Code routine required. That routine
 * (docs/ai-analysis-routine-setup.md) exists to protect a *multi-tenant*
 * deployment from Azure Cost Management's tight rate limit when many
 * concurrent dashboard users could otherwise trigger overlapping live calls;
 * a single local "Refresh" click has no such contention, so there's no
 * reason to make the user wait on infrastructure that isn't running. The
 * queued `cost_fetch_requests` row (and the polling on /api/cost-requests/:id
 * the frontend already does) is left in place — a routine, if one is ever
 * configured, can still pick up and complete a request this route left
 * pending for any reason (e.g. a crash mid-request). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const db = getDB();
    const subscriptionId: string = body?.subscriptionId ||
      (db.prepare("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id || '';

    const sub = getSubscription(subscriptionId);
    if (!sub) {
      return NextResponse.json({ error: 'No active subscription found.' }, { status: 404 });
    }

    // Don't queue a second request while one's already in flight for this
    // subscription — the routine polls on its own schedule regardless.
    const existing = getPendingCostFetchRequestFor(subscriptionId);
    const request = existing ?? createCostFetchRequest(subscriptionId);

    if (!existing) {
      try {
        await refreshCostSnapshot(subscriptionId);
        completeCostFetchRequest(request.id);
      } catch (e) {
        failCostFetchRequest(request.id, (e as Error).message);
      }
    }

    return NextResponse.json({ id: request.id, status: request.status }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
