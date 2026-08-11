import pool from './client'
import { ChatMessage, ChatThread } from '../types'

// --- threads ---

export async function findThreadsByAudit(auditId: string): Promise<ChatThread[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.audit_id, t.title, t.created_by, t.created_at, t.updated_at,
            COUNT(m.id)::int AS message_count
     FROM chat_threads t
     LEFT JOIN chat_messages m ON m.thread_id = t.id
     WHERE t.audit_id = $1
     GROUP BY t.id
     ORDER BY t.updated_at DESC`,
    [auditId]
  )
  return rows
}

export async function insertThread(auditId: string, userId: string, title: string): Promise<ChatThread> {
  const { rows } = await pool.query(
    `INSERT INTO chat_threads (audit_id, title, created_by)
     VALUES ($1, $2, $3)
     RETURNING id, audit_id, title, created_by, created_at, updated_at, 0 AS message_count`,
    [auditId, title, userId]
  )
  return rows[0]
}

export async function findThreadById(threadId: string): Promise<ChatThread | null> {
  const { rows } = await pool.query(
    `SELECT id, audit_id, title, created_by, created_at, updated_at FROM chat_threads WHERE id = $1`,
    [threadId]
  )
  return rows[0] || null
}

export async function updateThreadTitle(threadId: string, title: string): Promise<void> {
  await pool.query(`UPDATE chat_threads SET title = $2, updated_at = NOW() WHERE id = $1`, [threadId, title])
}

export async function touchThread(threadId: string): Promise<void> {
  await pool.query(`UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`, [threadId])
}

export async function deleteThread(threadId: string): Promise<boolean> {
  // thread_id FK is ON DELETE CASCADE — messages go with the thread.
  const { rowCount } = await pool.query(`DELETE FROM chat_threads WHERE id = $1`, [threadId])
  return (rowCount ?? 0) > 0
}

// --- messages ---

export async function findMessagesByThread(threadId: string): Promise<ChatMessage[]> {
  const { rows } = await pool.query(
    `SELECT id, audit_id, thread_id, user_id, role, content, created_at
     FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
    [threadId]
  )
  return rows
}

export async function findMessagesByAudit(auditId: string): Promise<ChatMessage[]> {
  const { rows } = await pool.query(
    `SELECT id, audit_id, thread_id, user_id, role, content, created_at
     FROM chat_messages WHERE audit_id = $1 ORDER BY created_at ASC`,
    [auditId]
  )
  return rows
}

export async function insertMessage(
  auditId: string,
  threadId: string,
  userId: string,
  role: string,
  content: string
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (audit_id, thread_id, user_id, role, content)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [auditId, threadId, userId, role, content]
  )
  return rows[0].id
}

export async function findMessageById(messageId: number): Promise<ChatMessage | null> {
  const { rows } = await pool.query(
    `SELECT id, audit_id, thread_id, user_id, role, content, created_at
     FROM chat_messages WHERE id = $1`,
    [messageId]
  )
  return rows[0] || null
}

export async function updateMessage(messageId: number, content: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE chat_messages SET content = $2 WHERE id = $1`,
    [messageId, content]
  )
  return (rowCount ?? 0) > 0
}

export async function deleteMessage(messageId: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM chat_messages WHERE id = $1`, [messageId])
  return (rowCount ?? 0) > 0
}
