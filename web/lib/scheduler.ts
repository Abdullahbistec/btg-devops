import { getDB, hasCostSnapshotHistoryRow, hasBackfillRequestToday, createCostBackfillRequest, completeCostFetchRequest, failCostFetchRequest, getStaleRunningAudits, failAudit, getHetznerCostSnapshot, saveHetznerCostSnapshot, hasMeasuredHetznerSnapshotToday, hasRunningAudit } from '@/lib/db';
import { executeAudit } from '@/lib/audit-executor';
import { refreshCostSnapshot, backfillCostHistory } from '@/lib/costManagement';
import { runHetznerCostReport } from '@/lib/btg-runner';
import { computeNextRun, toUtcTimestamp, NOW_UTC_SQL } from '@/lib/schedule-time';
import { createSingleFlightRunner } from '@/lib/single-flight';

const POLL_INTERVAL_MS = 60_000;

// Worst case for a full sequential scan is ~23 commands x 20min + one 40min
// 'idle' command, call it 8h — 12h gives that comfortable headroom before an
// audit still showing 'running' is treated as orphaned rather than slow.
const STALE_AUDIT_MAX_HOURS = 12;

// Matches the manual "Backfill 6 months" button's own window (see
// BACKFILL_MONTHS in web/app/cost/page.tsx) — kept as a separate constant
// since nothing currently shares one between the frontend button and this
// backend poller.
const BACKFILL_MONTHS = 6;

interface ScheduleRow {
  id: string;
  name: string;
  frequency: string;
  hour: number;
  times_per_day: number;
  enabled: number;
  subscription_id: string | null;
}

async function runDueSchedules() {
  const db = await getDB();
  let due: ScheduleRow[];
  try {
    const { rows } = await db.query(
      `SELECT id, name, frequency, hour, times_per_day, enabled, subscription_id FROM schedules
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${NOW_UTC_SQL}`
    );
    due = rows;
  } catch (e) {
    console.error('[scheduler] failed to query due schedules:', e);
    return;
  }

  for (const sched of due) {
    console.log(`[scheduler] running due schedule '${sched.name}' (${sched.id})`);
    try {
      await executeAudit(sched.subscription_id || '', undefined, `${sched.name} — ${toUtcTimestamp(new Date())}`);
    } catch (e) {
      console.error(`[scheduler] schedule '${sched.name}' failed to start:`, e);
    }
    const nextRun = computeNextRun(sched.frequency, sched.hour, new Date(), sched.times_per_day || 1);
    await db.query(`UPDATE schedules SET last_run_at = ${NOW_UTC_SQL}, next_run_at = $1 WHERE id = $2`, [nextRun, sched.id]);
  }
}

/** Refreshes each active subscription's cost data once per calendar day.
 * Checked every poll cycle rather than tracked via its own schedules-table
 * row — each check is one cheap indexed lookup per subscription, and
 * re-checking on every cycle means this self-heals if the server was down
 * when the day rolled over, with no separate "did we miss a day" logic
 * needed. "Today" comes from Postgres' own now(), matching exactly what
 * saveCostSnapshot() (web/lib/db.ts) stamps rows with, so this can never
 * disagree with what's actually in cost_snapshot_history. This is the
 * "works locally, before any deployment" half of daily cost refresh — see
 * docs/superpowers/specs/2026-08-25-cost-snapshot-history-design.md for the
 * GitHub Actions cron half, which only activates once DASHBOARD_BASE_URL
 * is set. */
async function runDailyCostRefresh() {
  // An audit's analyzer chain queries this same Cost Management API in the
  // background (executeAudit() fires it unawaited — see runDueSchedules),
  // so starting a refresh while one is running just stacks a second
  // concurrent caller onto the same tenant-wide rate limit. Skipping here
  // costs nothing: this function is re-checked every poll tick, so the
  // refresh runs on the very next tick after the audit finishes.
  if (await hasRunningAudit()) {
    console.log('[scheduler] skipping daily cost refresh — an audit is currently running');
    return;
  }

  const db = await getDB();
  let subs: { id: string; name: string }[];
  let today: string;
  try {
    const [subsRes, todayRes] = await Promise.all([
      db.query(`SELECT id, name FROM subscriptions WHERE is_active = 1`),
      db.query(`SELECT to_char(now(), 'YYYY-MM-DD') AS today`),
    ]);
    subs = subsRes.rows;
    today = todayRes.rows[0].today;
  } catch (e) {
    console.error('[scheduler] failed to query subscriptions for daily cost refresh:', e);
    return;
  }

  for (const sub of subs) {
    try {
      if (await hasCostSnapshotHistoryRow(sub.id, today)) continue;
      console.log(`[scheduler] running daily cost refresh for '${sub.name}' (${sub.id})`);
      await refreshCostSnapshot(sub.id);
    } catch (e) {
      console.error(`[scheduler] daily cost refresh failed for '${sub.name}':`, e);
    }
  }
}

/** Hetzner's counterpart to runDailyCostRefresh, run alongside it so a
 * deployment with no one clicking Refresh still accumulates Hetzner
 * snapshots too. Hetzner has no subscription concept — one project token
 * (HCLOUD_TOKEN), one global snapshot row — so instead of a per-subscription
 * cost_snapshot_history table this just checks the existing snapshot's own
 * fetched_at date. Kept fully separate from runDailyCostRefresh (own
 * try/catch, called via Promise.allSettled below) so a Hetzner failure
 * (e.g. HCLOUD_TOKEN not configured) can never suppress the Azure refresh,
 * nor the reverse. */
async function runDailyHetznerCostRefresh() {
  try {
    // Asks specifically for a MEASURED row, not any row. A reconstructed
    // snapshot is derived from resource creation dates, so letting one
    // satisfy this guard would mean a backfill run before the day's first
    // refresh makes the scheduler skip — leaving today permanently derived
    // when it could have been observed.
    if (await hasMeasuredHetznerSnapshotToday()) return;

    console.log('[scheduler] running daily Hetzner cost refresh');
    const report = await runHetznerCostReport();
    await saveHetznerCostSnapshot({
      totalMonthly: report.totalMonthly,
      currency: report.currency,
      byCategory: report.byCategory,
      byType: report.byType,
      unpriced: report.unpriced,
    });
  } catch (e) {
    console.error('[scheduler] daily Hetzner cost refresh failed:', e);
  }
}

/** Retries backfilling closed months once per calendar day per subscription
 * if the last attempt didn't fully succeed. backfillCostHistory() already
 * skips any month that already has its end-of-month row (see
 * hasCostSnapshotHistoryRow inside it), so calling it repeatedly is safe on
 * its own — the actual risk is calling it on every 60s poll cycle while
 * Azure is rate-limiting, which would hammer the API far harder than a
 * human clicking the button ever would. hasBackfillRequestToday is the
 * throttle: at most one attempt per subscription per day, whether that
 * attempt succeeds or fails, mirroring how a human would realistically
 * retry by hand — except this never forgets to. This is what closes the
 * gap runDailyCostRefresh leaves: that function only ever touches *today's*
 * row, so a month that closes without ever getting a clean day-by-day
 * refresh (e.g. the server was down, or Azure was rate-limiting every
 * attempt) stays permanently stuck until this retries the backfill. */
async function runDailyBackfillHeal() {
  // Same reasoning as runDailyCostRefresh's guard: backfillCostHistory hits
  // Cost Management too, and a 6-month backfill is the heaviest of these
  // callers — exactly what must not overlap a live audit.
  if (await hasRunningAudit()) {
    console.log('[scheduler] skipping daily backfill heal — an audit is currently running');
    return;
  }

  const db = await getDB();
  let subs: { id: string; name: string }[];
  try {
    const { rows } = await db.query(`SELECT id, name FROM subscriptions WHERE is_active = 1`);
    subs = rows;
  } catch (e) {
    console.error('[scheduler] failed to query subscriptions for daily backfill heal:', e);
    return;
  }

  for (const sub of subs) {
    try {
      if (await hasBackfillRequestToday(sub.id)) continue;
      console.log(`[scheduler] running daily backfill heal for '${sub.name}' (${sub.id})`);
      const request = await createCostBackfillRequest(sub.id, BACKFILL_MONTHS);
      try {
        const { saved, skipped, errors } = await backfillCostHistory(sub.id, BACKFILL_MONTHS);
        const note = errors.length ? `Backfilled ${saved} month(s), ${skipped} already had data, ${errors.length} failed: ${errors.join('; ')}` : undefined;
        await completeCostFetchRequest(request.id, note);
      } catch (e) {
        await failCostFetchRequest(request.id, (e as Error).message);
      }
    } catch (e) {
      console.error(`[scheduler] daily backfill heal failed for '${sub.name}':`, e);
    }
  }
}

/** Marks any audit stuck in 'running' well past the longest a real run could
 * take as failed. executeAudit() fires its command chain without awaiting it
 * and returns immediately — that chain lives only in the memory of the
 * process that started it. If the server restarts or crashes mid-run (dev
 * hot-reload, redeploy, crash), the chain is lost and nothing ever calls
 * updateAuditCounts()/failAudit() for that row, so without this heal it sits
 * as "running" in the UI forever instead of surfacing as a failure. */
async function healStaleAudits() {
  let stale: { id: string; name: string }[];
  try {
    stale = await getStaleRunningAudits(STALE_AUDIT_MAX_HOURS);
  } catch (e) {
    console.error('[scheduler] failed to query stale running audits:', e);
    return;
  }
  for (const audit of stale) {
    console.warn(`[scheduler] marking stale audit '${audit.name}' (${audit.id}) as failed — still 'running' after ${STALE_AUDIT_MAX_HOURS}h, likely orphaned by a server restart`);
    try {
      await failAudit(audit.id, `Timed out after ${STALE_AUDIT_MAX_HOURS}h without completing — the server likely restarted mid-run. Re-run manually.`);
    } catch (e) {
      console.error(`[scheduler] failAudit failed for stale audit ${audit.id}:`, e);
    }
  }
}

/** One poll cycle's work, run sequentially rather than fired concurrently.
 *
 * This used to launch runDueSchedules, the cost refreshes, and the backfill
 * heal all at once, unawaited. On a fresh start that meant a newly-kicked-off
 * audit's analyzer chain, a daily Azure cost refresh, a 6-month backfill, and
 * (independently) the Hetzner refresh were all issuing Cost Management calls
 * in the same instant — a thundering herd against a single tenant-wide rate
 * limit, which is exactly what produced sustained 429s on startup. Running
 * them one after another (plus the hasRunningAudit() guards above) spreads
 * that load out instead of piling it up.
 *
 * Hetzner is the one job still allowed to run alongside the rest: it never
 * touches Azure's Cost Management API, so it shares no rate limit with
 * anything else here and gains nothing from being serialized against it. */
async function runSchedulerCycle() {
  await runDueSchedules().catch(e => console.error('[scheduler] due-schedules poll failed:', e));
  await runDailyCostRefresh().catch(e => console.error('[scheduler] daily cost refresh poll failed:', e));
  await runDailyHetznerCostRefresh().catch(e => console.error('[scheduler] daily Hetzner cost refresh poll failed:', e));
  await runDailyBackfillHeal().catch(e => console.error('[scheduler] daily backfill heal poll failed:', e));
  await healStaleAudits().catch(e => console.error('[scheduler] stale audit heal poll failed:', e));
}

let started = false;

/** Starts the in-process schedule poller. Idempotent — safe to call multiple
 * times (e.g. across Next.js dev-mode hot reloads); only the first call takes
 * effect. Runs for as long as the Next.js server process is alive. */
export function startScheduler() {
  if (started) return;
  started = true;
  console.log('[scheduler] started, polling every 60s for due schedules');

  // Single-flight, not just sequential: a cycle whose audit or backfill step
  // is still working through 429 backoff can easily outlast one 60s
  // interval. Without this guard, the next tick starts a second cycle on top
  // of the first — the same pile-up this whole restructure exists to avoid,
  // just moved from "within one tick" to "across ticks".
  const runCycle = createSingleFlightRunner(runSchedulerCycle);

  setInterval(() => { runCycle(); }, POLL_INTERVAL_MS);
  // Also do an immediate check on startup rather than waiting a full interval.
  runCycle();
}
