import { getDB } from './core';

// ── Users ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] ?? null;
}

export async function createUser(id: string, email: string, name: string, passwordHash: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `INSERT INTO users (id, email, name, password_hash, role, status) VALUES ($1, $2, $3, $4, 'viewer', 'pending')`,
    [id, email.toLowerCase(), name, passwordHash]
  );
}

export async function listUsers(status?: string): Promise<User[]> {
  const db = await getDB();
  if (status) {
    const { rows } = await db.query('SELECT * FROM users WHERE status = $1 ORDER BY created_at DESC', [status]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM users ORDER BY created_at DESC');
  return rows;
}

export async function updateUserStatus(id: string, status: string, approvedBy: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE users SET status = $1, approved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), approved_by = $2 WHERE id = $3`,
    [status, approvedBy, id]
  );
}

export async function deleteUser(id: string): Promise<void> {
  const db = await getDB();
  await db.query('DELETE FROM users WHERE id = $1', [id]);
}

