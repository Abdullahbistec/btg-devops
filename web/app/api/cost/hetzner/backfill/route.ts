import { NextRequest, NextResponse } from 'next/server';
import { runHetznerCostHistory } from '@/lib/btg-runner';
import { saveHetznerReconstructedHistory } from '@/lib/db';
import { isAdminRequest, getVerifiedIdentity } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { consumeRateLimit, rateLimited } from '@/lib/rate-limit';
import { recordAuditLog } from '@/lib/audit-log';

const DEFAULT_DAYS = 180;
const MAX_DAYS = 730;

/** Reconstructs past run-rate days from resource creation dates.
 *
 * The Azure equivalent (Backfill on the Billing History card) fetches real
 * past months from Cost Management. This cannot do that — Hetzner has no
 * invoice or spend-history endpoint — so it derives the fleet's composition
 * on each past day from every resource's `created` timestamp and prices it
 * with today's list prices.
 *
 * Two limits the caller must surface, not bury:
 *   1. Deleted resources are invisible. Anything created and destroyed before
 *      today is absent from the inventory, so past days are UNDERSTATED.
 *   2. Past days use today's prices. Any repricing since makes earlier points
 *      wrong by that difference.
 *
 * Every row it writes is flagged `reconstructed`, and a real measurement for
 * a day always wins over a derived one.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const limit = await consumeRateLimit(`hetzner-backfill:account:${getVerifiedIdentity(req)}`, 3, 3600);
  if (!limit.allowed) return rateLimited(limit);
  try {
    const body = await req.json().catch(() => ({}));
    const requested = Math.floor(Number(body?.days) || DEFAULT_DAYS);
    const days = Math.min(Math.max(requested, 1), MAX_DAYS);

    const points = await runHetznerCostHistory(days);
    await saveHetznerReconstructedHistory(points);
    await recordAuditLog(req, 'hetzner.backfill', { days, reconstructed: points.length });

    return NextResponse.json({
      reconstructed: points.length,
      days,
      note: 'Derived from resource creation dates at current list prices. Resources deleted before today are invisible, so past days are understated.',
    });
  } catch (e) {
    return apiError(e, 'POST /api/cost/hetzner/backfill');
  }
}
