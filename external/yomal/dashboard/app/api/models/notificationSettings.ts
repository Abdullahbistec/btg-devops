import pool from './client'

export interface RoleNotificationSetting {
  role: 'admin' | 'analyst' | 'viewer'
  enabled: boolean
  updated_at: string
}

export async function findRoleSettings(): Promise<RoleNotificationSetting[]> {
  const { rows } = await pool.query(
    `SELECT role, enabled, updated_at FROM notification_role_settings ORDER BY role ASC`
  )
  return rows
}

export async function setRoleEnabled(role: string, enabled: boolean): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE notification_role_settings SET enabled = $2, updated_at = NOW() WHERE role = $1`,
    [role, enabled]
  )
  return (rowCount ?? 0) > 0
}
