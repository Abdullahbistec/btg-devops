import { randomUUID } from 'crypto';
import { getDB } from './core';

// ── Analysis requests (async AI analysis via the MCP + Claude Code routine) ────

export interface AnalysisRequest {
  id: string;
  audit_id: string;
  scope: string;
  status: 'pending' | 'done' | 'failed';
  summary: string;
  error_message: string;
  requested_at: string;
  completed_at: string | null;
}

export async function createAnalysisRequest(auditId: string, scope: string): Promise<AnalysisRequest> {
  const db = await getDB();
  const id = randomUUID();
  await db.query(`INSERT INTO analysis_requests (id, audit_id, scope) VALUES ($1, $2, $3)`, [id, auditId, scope]);
  return (await getAnalysisRequest(id))!;
}

export async function getAnalysisRequest(id: string): Promise<AnalysisRequest | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM analysis_requests WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function listPendingAnalysisRequests(): Promise<AnalysisRequest[]> {
  const db = await getDB();
  const { rows } = await db.query(`SELECT * FROM analysis_requests WHERE status = 'pending' ORDER BY requested_at`);
  return rows;
}

export async function completeAnalysisRequest(id: string, summary: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE analysis_requests SET status = 'done', summary = $1, completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [summary, id]
  );
}

export async function failAnalysisRequest(id: string, message: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE analysis_requests SET status = 'failed', error_message = $1, completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [message, id]
  );
}

