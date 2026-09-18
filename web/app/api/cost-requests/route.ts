import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  getDB, getSubscription, createCostFetchRequest, createCostBackfillRequest, getPendingCostFetchRequestFor,
  completeCostFetchRequest, failCostFetchRequest, saveHetznerCostSnapshot,
} from '@/lib/db';
import { refreshCostSnapshot, backfillCostHistory } from '@/lib/costManagement';
import { runHetznerCostReport } from '@/lib/btg-runner';
import { isAdminRequest, getVerifiedIdentity } from '@/lib/auth';
import { apiError, logServerError } from '@/lib/api-error';
import { consumeRateLimit, rateLimited } from '@/lib/rate-limit';

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

    // 20/hour comfortably covers the scheduled refresh (one per subscription,
    // four workflow runs a day) and a person clicking Refresh, while capping
    // how hard this route can be made to hammer Azure Cost Management's
    // tenant-wide rate limit.
    const limit = await consumeRateLimit(`cost-requests:account:${getVerifiedIdentity(req)}`, 20, 3600);
    if (!limit.allowed) return rateLimited(limit);

    const body = await req.json().catch(() => ({}));

    // Optional `provider`, defaulting to 'azure' so every existing caller
    // (the Refresh button, the scheduled-audit cron script) that sends no
    // provider at all is completely unaffected. Hetzner has no subscription
    // concept — a single project token (HCLOUD_TOKEN) covers the whole
    // account, priced from Hetzner's own pricing API rather than a live
    // spend query — so it bypasses the subscription lookup and the
    // cost_fetch_requests bookkeeping below entirely, which are both keyed
    // by subscription_id.
    const provider: 'azure' | 'hetzner' = body?.provider === 'hetzner' ? 'hetzner' : 'azure';
    if (provider === 'hetzner') {
      try {
        const report = await runHetznerCostReport();
        await saveHetznerCostSnapshot({
          totalMonthly: report.totalMonthly,
          currency: report.currency,
          byCategory: report.byCategory,
          byType: report.byType,
          unpriced: report.unpriced,
        });
        // Same {id, status} shape as the Azure branch below, even though this
        // id is synthetic (nothing is queued in cost_fetch_requests for
        // Hetzner) — the Hetzner refresh completes synchronously above, so a
        // caller has no reason to poll it, but a shape that looks like the
        // Azure response is one a polling caller can't mistake for "no id".
        return NextResponse.json({ id: randomUUID(), status: 'done' }, { status: 202 });
      } catch (e) {
        return apiError(e, 'POST /api/cost-requests (hetzner refresh)');
      }
    }

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
        const correlationId = logServerError(e, 'POST /api/cost-requests (background refresh/backfill)');
        await failCostFetchRequest(request.id, `Fetch failed on our side. Reference: ${correlationId}`);
      }
    }

    return NextResponse.json({ id: request.id, status: request.status }, { status: 202 });
  } catch (e) {
    return apiError(e, 'POST /api/cost-requests');
  }
}
