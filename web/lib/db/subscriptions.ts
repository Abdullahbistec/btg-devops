import { randomUUID } from 'crypto';
import { getDB } from './core';
import { encryptSecret } from '../crypto';

// ── Subscriptions ─────────────────────────────────────────────────────────────

export interface Subscription {
  id: string;
  name: string;
  subscription_id: string;
  tenant_id: string;
  client_id: string;
  is_active: number;
  created_at: string;
  last_audit_at: string | null;
  monthly_budget: number | null;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const db = await getDB();
  const { rows } = await db.query(`
    SELECT id, name, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at, monthly_budget
    FROM subscriptions ORDER BY created_at DESC
  `);
  return rows;
}

/** Minimal, non-sensitive subscription list (id/name/active only) — safe for
 * viewer-level read access, unlike listSubscriptions() which is admin-only. */
export async function listSubscriptionsBasic(): Promise<{ id: string; name: string; is_active: number }[]> {
  const db = await getDB();
  const { rows } = await db.query(`SELECT id, name, is_active FROM subscriptions ORDER BY created_at DESC`);
  return rows;
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT id, name, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at, monthly_budget
     FROM subscriptions WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** Nullable — a subscription with no budget set simply hides budget-dependent
 * UI (Cost page tiles, reference lines) rather than falling back to a made-up
 * number. */
export async function updateSubscriptionBudget(id: string, monthlyBudget: number | null): Promise<void> {
  const db = await getDB();
  await db.query(`UPDATE subscriptions SET monthly_budget = $1 WHERE id = $2`, [monthlyBudget, id]);
}

export async function createSubscription(
  data: Omit<Subscription, 'id' | 'created_at' | 'last_audit_at' | 'is_active' | 'monthly_budget'> & { client_secret?: string }
): Promise<Subscription> {
  const db = await getDB();
  const id = randomUUID();
  await db.query(
    `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, client_secret)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, data.name, data.subscription_id, data.tenant_id, data.client_id, data.client_secret ? encryptSecret(data.client_secret) : '']
  );
  return (await getSubscription(id))!;
}

