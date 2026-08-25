import { NextResponse } from 'next/server';
import { getDB, getSubscription, getCostSnapshotHistory } from '@/lib/db';

// Sibling to /api/cost/spend — that route reads the latest-only
// cost_snapshots row; this one reads the additive cost_snapshot_history
// table (see docs/superpowers/specs/2026-08-25-cost-snapshot-history-design.md).
// Same subscription-resolution fallback as /api/cost/spend, kept identical
// on purpose so the two routes behave consistently for the same caller.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const subParam = url.searchParams.get('subscription_id');
    const daysParam = url.searchParams.get('days');
    const days = daysParam ? Math.max(1, parseInt(daysParam, 10) || 90) : 90;
    const db = getDB();

    const resolvedSubId = subParam ||
      (db.prepare("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id || '';
    const sub = getSubscription(resolvedSubId);
    if (!sub) {
      return NextResponse.json({ error: 'No active subscription found. Add one in Settings.' }, { status: 404 });
    }

    const rows = getCostSnapshotHistory(resolvedSubId, days);
    return NextResponse.json({
      subscription: { id: sub.id, name: sub.name },
      currency: rows[0]?.currency ?? 'USD',
      points: rows.map(r => ({
        date: r.snapshot_date,
        totalCost: r.total_cost,
        byService: JSON.parse(r.by_service),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
