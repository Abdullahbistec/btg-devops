import { NextRequest, NextResponse } from 'next/server';
import { getHetznerCostHistory } from '@/lib/db';
import { isAuthenticatedRequest } from '@/lib/auth';

const DEFAULT_DAYS = 90;

// Sibling to /api/cost/history (Azure) but measuring something different, and
// the difference is the whole reason this is a separate route rather than a
// provider param. Azure's history is what was SPENT, day by day, billed by
// Cost Management. This is what the infrastructure COSTS PER MONTH as measured
// on each day — it moves when a server is added or removed, not when anything
// is consumed. `runRate: true` travels with the payload so the UI cannot
// present it as spend.
//
// Like the other cost routes this reads only stored snapshots and never calls
// Hetzner. History accumulates from the first refresh onward and cannot be
// backfilled: the hcloud API has no invoice or spend-history endpoint, so
// there is no past to fetch.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get('days');
    const parsed = raw ? parseInt(raw, 10) : DEFAULT_DAYS;
    const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1500) : DEFAULT_DAYS;

    const points = await getHetznerCostHistory(days);
    return NextResponse.json({
      points,
      currency: points[points.length - 1]?.currency ?? 'USD',
      runRate: true,
      estimate: true,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
