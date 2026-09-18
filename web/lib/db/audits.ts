import { randomUUID } from 'crypto';
import { getDB } from './core';

// ── Audits ────────────────────────────────────────────────────────────────────

export interface Audit {
  id: string;
  subscription_id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: string | null;
  completed_at: string | null;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  commands_run: string[];
  error_message: string;
  current_step?: string;
  total_steps?: number;
  completed_steps?: number;
}

export async function listAudits(subscriptionId?: string): Promise<Audit[]> {
  const db = await getDB();
  if (subscriptionId) {
    const { rows } = await db.query('SELECT * FROM audits WHERE subscription_id = $1 ORDER BY started_at DESC', [subscriptionId]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM audits ORDER BY started_at DESC');
  return rows;
}

export async function getAudit(id: string): Promise<Audit | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM audits WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function createAudit(subscriptionId: string, name: string, plannedCommands: string[] = []): Promise<Audit> {
  const db = await getDB();
  const id = randomUUID();
  await db.query(
    `INSERT INTO audits (id, subscription_id, name, status, started_at, total_steps, commands_run)
     VALUES ($1, $2, $3, 'running', now(), $4, $5)`,
    [id, subscriptionId, name, plannedCommands.length, JSON.stringify(plannedCommands)]
  );
  return (await getAudit(id))!;
}

/** Called as each analyzer command starts, so the UI can show real progress
 * instead of a simulated timer. */
export async function updateAuditStep(id: string, currentStep: string, completedSteps: number): Promise<void> {
  const db = await getDB();
  await db.query(`UPDATE audits SET current_step = $1, completed_steps = $2 WHERE id = $3`, [currentStep, completedSteps, id]);
}

/** `note` records a partial failure on an otherwise successful audit — some
 * commands ran, others errored. Stored in the same error_message column as a
 * hard failure; status ('completed' vs 'failed') is what distinguishes them,
 * mirroring completeCostFetchRequest(). */
export async function updateAuditCounts(id: string, critical: number, warning: number, info: number, commands: string[], resourcesScanned = 0, note?: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE audits SET
       total_findings = $1,
       critical_count = $2,
       warning_count = $3,
       info_count = $4,
       commands_run = $5,
       resources_scanned = $6,
       status = 'completed',
       error_message = $7,
       completed_at = now()
     WHERE id = $8`,
    [critical + warning + info, critical, warning, info, JSON.stringify(commands), resourcesScanned, note ?? '', id]
  );

  const audit = await getAudit(id);
  if (audit) {
    await db.query(`UPDATE subscriptions SET last_audit_at = now() WHERE id = $1`, [audit.subscription_id]);
  }
}

export async function failAudit(id: string, message: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE audits SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`,
    [message, id]
  );
}

/** Audits stuck in 'running' longer than maxAgeHours — orphaned by a server
 * restart/crash mid-run (executeAudit's promise chain lives only in that
 * process's memory; nothing else ever revisits the row once created). Used
 * by the scheduler's stale-audit heal to stop these from sitting as
 * permanently "running" in the UI. Compared against plain now(), matching
 * the basis createAudit() already stamps started_at with. */
export async function getStaleRunningAudits(maxAgeHours: number): Promise<{ id: string; name: string }[]> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT id, name FROM audits
     WHERE status = 'running' AND started_at <= now() - ($1 || ' hours')::interval`,
    [maxAgeHours]
  );
  return rows;
}

/** Whether any audit is currently running, of any age.
 *
 * Used to hold off the scheduler's daily cost refresh and backfill heal:
 * an audit's analyzer chain (executeAudit() fires it unawaited) queries the
 * same Cost Management API those jobs do, so starting them while an audit
 * is already mid-run stacks concurrent callers onto the same tenant-wide
 * rate limit instead of spreading them out. */
export async function hasRunningAudit(): Promise<boolean> {
  const db = await getDB();
  const { rows } = await db.query(`SELECT 1 FROM audits WHERE status = 'running' LIMIT 1`);
  return rows.length > 0;
}

