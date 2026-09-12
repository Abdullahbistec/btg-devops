import { NextResponse } from 'next/server';
import { getHetznerCostSnapshot } from '@/lib/db';

// Reads only the stored snapshot — never calls Hetzner. Mirrors
// /api/cost/spend. Unlike Azure this figure is a list-price estimate, never
// a bill, and `estimate: true` travels with it so the UI cannot forget.
export async function GET() {
  try {
    const snap = await getHetznerCostSnapshot();
    if (!snap) {
      return NextResponse.json({
        noData: true,
        message: 'No Hetzner cost snapshot yet. Click Refresh to request one.',
      });
    }
    return NextResponse.json({
      totalMonthly: snap.total_monthly,
      currency: snap.currency,
      byCategory: JSON.parse(snap.by_category),
      byType: JSON.parse(snap.by_type),
      unpriced: snap.unpriced ? JSON.parse(snap.unpriced) : [],
      fetchedAt: snap.fetched_at,
      estimate: true,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
