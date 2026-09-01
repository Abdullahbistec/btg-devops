import { NextRequest, NextResponse } from 'next/server';
import {
  getDB, getSubscription, createCostFetchRequest, createCostBackfillRequest, getPendingCostFetchRequestFor,
  completeCostFetchRequest, failCostFetchRequest,
} from '@/lib/db';
import { refreshCostSnapshot, backfillCostHistory } from '@/lib/costManagement';
import { isAdminRequest } from '@/lib/auth';

function backfillNote(saved: number, skipped: number, errors: string[]): string | undefined {
  if (errors.length === 0) return undefined;
  return `Backfilled ${saved} month(s), ${skipped} already had data, ${errors.length} failed: ${errors.join('; ')}`;
}

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
    // This route spends money-adjacent quota: it makes live Azure Cost
    // Management calls, and a backfill makes one per month requested. Every
    // other mutating route (/api/subscriptions, /api/audits/run,
    // /api/schedule) is admin-only; this one was not, so any signed-in
    // viewer could trigger a 6-month backfill against Azure's tight rate
    // limit. The scheduled cron caller (scripts/run-scheduled-cost-refresh.js)
    // already logs in as ADMIN_EMAIL and is unaffected.
    if (!(await isAdminRequest(req))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const db = await getDB();
    const activeRes = await db.query("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1");
    const subscriptionId: string = body?.subscriptionId || (activeRes.rows[0] as { id: string } | undefined)?.id || '';

    const sub = await getSubscription(subscriptionId);
    if (!sub) {
      return NextResponse.json({ error: 'No active subscription found.' }, { status: 404 });
    }

    // A positive integer here switches this from a live MonthToDate refresh
    // to a one-time historical backfill of the last N calendar months —
    // see backfillCostHistory(). Anything else falls back to the normal
    // refresh so existing callers (the Refresh button, the scheduled-audit
    // cron script) are unaffected.
    const backfillMonths = Math.max(0, Math.floor(Number(body?.backfillMonths) || 0));

    // Don't queue a second request while one's already in flight for this
    // subscription — the routine polls on its own schedule regardless.
    const existing = await getPendingCostFetchRequestFor(subscriptionId, backfillMonths > 0 ? 'backfill' : 'refresh');
    const request = existing ?? (backfillMonths > 0
      ? await createCostBackfillRequest(subscriptionId, backfillMonths)
      : await createCostFetchRequest(subscriptionId));

    if (!existing) {
      try {
        if (backfillMonths > 0) {
          const { saved, skipped, errors } = await backfillCostHistory(subscriptionId, backfillMonths);
          await completeCostFetchRequest(request.id, backfillNote(saved, skipped, errors));
        } else {
          await refreshCostSnapshot(subscriptionId);
          await completeCostFetchRequest(request.id);
        }
      } catch (e) {
        await failCostFetchRequest(request.id, (e as Error).message);
      }
    }

    return NextResponse.json({ id: request.id, status: request.status }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
