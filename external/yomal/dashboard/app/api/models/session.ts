import pool from './client'
import { createHash } from 'crypto'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function insertSession(
  userId: string,
  token: string,
  ipAddress: string,
  userAgent: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await pool.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, ipAddress, userAgent]
  )
}

export async function findSession(token: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT user_id FROM user_sessions
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [hashToken(token)]
  )
  return rows[0]?.user_id || null
}

export async function removeSession(token: string): Promise<void> {
  await pool.query(
    `DELETE FROM user_sessions WHERE token_hash = $1`,
    [hashToken(token)]
  )
}
