import pool from './client'
import { Resource } from '../types'

export async function findAllResources(): Promise<Resource[]> {
  const { rows } = await pool.query(
    `SELECT id, slug, name, description FROM resources ORDER BY id ASC`
  )
  return rows
}

export async function findResourceBySlug(slug: string): Promise<Resource | null> {
  const { rows } = await pool.query(
    `SELECT id, slug, name, description FROM resources WHERE slug = $1`,
    [slug]
  )
  return rows[0] || null
}

export async function insertResource(slug: string, name: string, description: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO resources (slug, name, description) VALUES ($1, $2, $3) RETURNING id`,
    [slug, name, description]
  )
  return rows[0].id
}

export async function updateResource(
  slug: string,
  fields: { name?: string; description?: string }
): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = [slug]
  let i = 2
  if (fields.name !== undefined) { sets.push(`name = $${i++}`); values.push(fields.name) }
  if (fields.description !== undefined) { sets.push(`description = $${i++}`); values.push(fields.description) }
  if (sets.length === 0) return false
  const { rowCount } = await pool.query(
    `UPDATE resources SET ${sets.join(', ')} WHERE slug = $1`,
    values
  )
  return (rowCount ?? 0) > 0
}

export async function deleteResource(slug: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM resources WHERE slug = $1`, [slug])
  return (rowCount ?? 0) > 0
}
