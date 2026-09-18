import { randomUUID } from 'crypto';
import type { NextRequest } from 'next/server';
import { getDB } from './db';
import { getVerifiedIdentity } from './auth';
import { clientIp } from './rate-limit';

export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  detail: string;
  ip: string;
  created_at: string;
}

/** Appends one privileged action to the audit trail.
 *
 * Never throws and never rejects: this is bookkeeping about an action, not
 * the action itself, and a failed insert must not turn a working scan into a
 * 500. Failures go to the server log instead. */
export async function recordAuditLog(
  req: NextRequest,
  action: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    const db = await getDB();
    await db.query(
      `INSERT INTO audit_log (id, actor, action, detail, ip) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), getVerifiedIdentity(req), action, JSON.stringify(detail), clientIp(req)]
    );
  } catch (e) {
    console.error(`[audit-log] failed to record "${action}":`, e);
  }
}

export async function listAuditLog(limit = 200): Promise<AuditLogRow[]> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT id, actor, action, detail, ip, created_at
     FROM audit_log ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return rows as AuditLogRow[];
}
