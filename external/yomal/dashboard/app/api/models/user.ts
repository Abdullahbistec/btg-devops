import pool from './client'
import { User } from '../types'

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, is_active, created_at, last_login
     FROM users WHERE email = $1`,
    [email]
  )
  return rows[0] || null
}

export async function findAllUsers(): Promise<User[]> {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, is_active, created_at, last_login
     FROM users ORDER BY created_at ASC`
  )
  return rows
}

export async function insertUser(
  email: string,
  passwordHash: string,
  role: string,
  createdBy: string
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, passwordHash, role, createdBy]
  )
  return rows[0].id
}

export async function patchUser(
  userId: string,
  role?: string,
  isActive?: boolean
): Promise<void> {
  if (role !== undefined) {
    await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [userId, role])
  }
  if (isActive !== undefined) {
    await pool.query(`UPDATE users SET is_active = $2 WHERE id = $1`, [userId, isActive])
  }
}

export async function touchLastLogin(userId: string): Promise<void> {
  await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [userId])
}

export async function findUserById(userId: string): Promise<User | null> {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, is_active, created_at, last_login
     FROM users WHERE id = $1`,
    [userId]
  )
  return rows[0] || null
}

export async function deleteUser(userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [userId])
  return (rowCount ?? 0) > 0
}
