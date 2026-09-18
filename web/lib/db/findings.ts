import { randomUUID } from 'crypto';
import { getDB } from './core';

// ── Findings ──────────────────────────────────────────────────────────────────

export interface Finding {
  id: string;
  audit_id: string;
  service: string;
  resource: string;
  environment: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  owner: string;
  location: string;
  monthly_cost: number | null;
  monthly_saving: number | null;
  confidence: number | null;
  reasoning: string | null;
  currency: string | null;
  created_at: string;
}

export async function insertFindings(auditId: string, findings: Omit<Finding, 'id' | 'audit_id' | 'created_at'>[]): Promise<void> {
  const db = await getDB();
  const client = await db.connect();
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    for (const f of findings) {
      await client.query(
        `INSERT INTO findings (id, audit_id, service, resource, environment, severity, category, description, recommendation, owner, location, monthly_cost, monthly_saving, confidence, reasoning, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [randomUUID(), auditId, f.service, f.resource, f.environment, f.severity, f.category, f.description, f.recommendation, f.owner || '', f.location || '', f.monthly_cost ?? null, f.monthly_saving ?? null, f.confidence ?? null, f.reasoning || null, f.currency ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    // A failing ROLLBACK must not replace the error that caused it — the
    // usual reason rollback fails is that the connection itself died, which
    // is exactly the diagnostic the caller needs. A client whose rollback
    // failed is also in an unknown transaction state, so it is destroyed
    // rather than handed back to the pool for someone else to inherit.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      destroyClient = true;
      console.error('[db] ROLLBACK failed in insertFindings:', rollbackError);
    }
    throw e;
  } finally {
    client.release(destroyClient);
  }
}

export async function listFindings(auditId?: string, severity?: string): Promise<Finding[]> {
  const db = await getDB();
  if (auditId && severity) {
    const { rows } = await db.query('SELECT * FROM findings WHERE audit_id = $1 AND severity = $2 ORDER BY severity, service', [auditId, severity]);
    return rows;
  }
  if (auditId) {
    const { rows } = await db.query('SELECT * FROM findings WHERE audit_id = $1 ORDER BY severity, service', [auditId]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM findings ORDER BY created_at DESC, severity');
  return rows;
}

