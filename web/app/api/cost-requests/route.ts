import { NextRequest, NextResponse } from 'next/server';
import { getDB, getSubscription, createCostFetchRequest, getPendingCostFetchRequestFor } from '@/lib/db';

/** Creates a pending cost-refresh request. A scheduled Claude Code routine,
 * polling through the MCP server (cmd/mcp.go --http), picks it up and calls
 * back into /api/internal/cost-requests/[id]/fetch to do the actual live
 * Azure call. See docs/ai-analysis-routine-setup.md. */
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

    return NextResponse.json({ id: request.id, status: request.status }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
