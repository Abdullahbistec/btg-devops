import { getDB } from '@/lib/db';
import { executeAudit } from '@/lib/audit-executor';

const POLL_INTERVAL_MS = 60_000;

interface ScheduleRow {
  id: string;
  name: string;
  frequency: string;
  hour: number;
  enabled: number;
  subscription_id: string | null;
}

function computeNextRun(frequency: string, hour: number): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) {
    if (frequency === 'daily') next.setDate(next.getDate() + 1);
    else if (frequency === 'weekly') next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);
  }
  return next.toISOString().slice(0, 19).replace('T', ' ');
}

async function runDueSchedules() {
  const db = await getDB();
  let due: ScheduleRow[];
  try {
    const { rows } = await db.query(
      `SELECT id, name, frequency, hour, enabled, subscription_id FROM schedules
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`
    );
    due = rows;
  } catch (e) {
    console.error('[scheduler] failed to query due schedules:', e);
    return;
  }

  for (const sched of due) {
    console.log(`[scheduler] running due schedule '${sched.name}' (${sched.id})`);
    try {
      await executeAudit(sched.subscription_id || '', undefined, `${sched.name} — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
    } catch (e) {
      console.error(`[scheduler] schedule '${sched.name}' failed to start:`, e);
    }
    const nextRun = computeNextRun(sched.frequency, sched.hour);
    await db.query(`UPDATE schedules SET last_run_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), next_run_at = $1 WHERE id = $2`, [nextRun, sched.id]);
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
  }, POLL_INTERVAL_MS);
  // Also do an immediate check on startup rather than waiting a full interval.
  runDueSchedules().catch(e => console.error('[scheduler] initial poll failed:', e));
}
