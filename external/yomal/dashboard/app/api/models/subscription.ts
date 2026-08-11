import pool from './client'
import { Subscription } from '../types'

export async function findAllSubscriptions(): Promise<Subscription[]> {
  const { rows } = await pool.query(
    `SELECT id, name, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at
     FROM subscriptions ORDER BY created_at ASC`
  )
  return rows
}

export async function findSubscriptionById(id: string): Promise<Subscription | null> {
  const { rows } = await pool.query(
    `SELECT id, name, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at
     FROM subscriptions WHERE id = $1`,
    [id]
  )
  return rows[0] || null
}

export async function insertSubscription(
  name: string,
  subscriptionId: string,
  tenantId: string,
  clientId: string,
  clientSecretEnc: string,
  createdBy: string
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (name, subscription_id, tenant_id, client_id, client_secret_enc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, subscriptionId, tenantId, clientId, clientSecretEnc, createdBy]
  )
  return rows[0].id
}

export async function updateSubscription(
  id: string,
  fields: { name?: string; tenant_id?: string; client_id?: string; client_secret_enc?: string; is_active?: boolean }
): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = [id]
  let i = 2
  if (fields.name !== undefined) { sets.push(`name = $${i++}`); values.push(fields.name) }
  if (fields.tenant_id !== undefined) { sets.push(`tenant_id = $${i++}`); values.push(fields.tenant_id) }
  if (fields.client_id !== undefined) { sets.push(`client_id = $${i++}`); values.push(fields.client_id) }
  if (fields.client_secret_enc !== undefined) { sets.push(`client_secret_enc = $${i++}`); values.push(fields.client_secret_enc) }
  if (fields.is_active !== undefined) { sets.push(`is_active = $${i++}`); values.push(fields.is_active) }
  if (sets.length === 0) return false
  const { rowCount } = await pool.query(
    `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = $1`,
    values
  )
  return (rowCount ?? 0) > 0
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM subscriptions WHERE id = $1`, [id])
  return (rowCount ?? 0) > 0
}
