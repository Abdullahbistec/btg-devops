import { NextResponse } from 'next/server';
import { getDB, getSubscription, getCostSnapshot } from '@/lib/db';

// Reads ONLY the last snapshot written by the MCP + Claude-routine mechanism
// (see docs/ai-analysis-routine-setup.md) — this route never calls Azure
// live. That's deliberate: Cost Management's rate limit is tight enough
// (tenant-wide, shared across every caller) that calling it from a page
// load caused recurring user-visible 429s. To request a fresh number, POST
// /api/cost-requests instead and poll it — see web/app/cost/page.tsx.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const subParam = url.searchParams.get('subscription_id');
    const db = await getDB();

    const activeRes = await db.query("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1");
    const resolvedSubId = subParam || (activeRes.rows[0] as { id: string } | undefined)?.id || '';
    const sub = await getSubscription(resolvedSubId);
    if (!sub) {
      return NextResponse.json({ error: 'No active subscription found. Add one in Settings.' }, { status: 404 });
    }

    const snapshot = await getCostSnapshot(resolvedSubId);
    if (!snapshot) {
      return NextResponse.json({
        subscription: { id: sub.id, name: sub.name },
        noData: true,
        message: 'No cost data fetched yet for this subscription. Click Refresh to request one.',
        monthlyBudget: sub.monthly_budget,
      });
    }

    return NextResponse.json({
      subscription: { id: sub.id, name: sub.name },
      timeframe: 'MonthToDate',
      totalCost: snapshot.total_cost,
      currency: snapshot.currency,
      byService: JSON.parse(snapshot.by_service),
      byResourceGroup: JSON.parse(snapshot.by_resource_group),
      fetchedAt: snapshot.fetched_at,
      monthlyBudget: sub.monthly_budget,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
