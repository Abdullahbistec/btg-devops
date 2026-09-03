import { getDB, hasCostSnapshotHistoryRow } from '@/lib/db';
import { executeAudit } from '@/lib/audit-executor';
import { refreshCostSnapshot } from '@/lib/costManagement';
import { computeNextRun, toUtcTimestamp, NOW_UTC_SQL } from '@/lib/schedule-time';

const POLL_INTERVAL_MS = 60_000;

interface ScheduleRow {
  id: string;
  name: string;
  frequency: string;
  hour: number;
  enabled: number;
  subscription_id: string | null;
}

async function runDueSchedules() {
  const db = await getDB();
  let due: ScheduleRow[];
  try {
    const { rows } = await db.query(
      `SELECT id, name, frequency, hour, enabled, subscription_id FROM schedules
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
    const nextRun = computeNextRun(sched.frequency, sched.hour);
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

let started = false;

/** Starts the in-process schedule poller. Idempotent — safe to call multiple
 * times (e.g. across Next.js dev-mode hot reloads); only the first call takes
 * effect. Runs for as long as the Next.js server process is alive. */
export function startScheduler() {
  if (started) return;
  started = true;
  console.log('[scheduler] started, polling every 60s for due schedules');
  setInterval(() => {
    runDueSchedules().catch(e => console.error('[scheduler] poll cycle failed:', e));
    runDailyCostRefresh().catch(e => console.error('[scheduler] daily cost refresh poll failed:', e));
  }, POLL_INTERVAL_MS);
  // Also do an immediate check on startup rather than waiting a full interval.
  runDueSchedules().catch(e => console.error('[scheduler] initial poll failed:', e));
  runDailyCostRefresh().catch(e => console.error('[scheduler] initial daily cost refresh failed:', e));
}
