import pool from './client'
import { Audit, AuditDetail, CostDataRaw, UsageDataRaw } from '../types'

export interface AuditCostUsageRaw {
  cost: CostDataRaw | null
  usage: UsageDataRaw | null
  claude_analysis: Record<string, unknown> | null
}

export interface AuditCostRaw {
  cost: CostDataRaw | null
  claude_analysis: Record<string, unknown> | null
}

export async function findAllAudits(): Promise<Audit[]> {
  const { rows } = await pool.query(
    `SELECT id, created_at, subscription_id,
            COALESCE(subscription_name, '') AS subscription_name,
            trigger_type, status, current_step,
            COALESCE(error_message, '') AS error_message,
            COALESCE(resource_counts, '{}'::jsonb) AS resource_counts,
            claude_analysis IS NOT NULL AS has_analysis
     FROM audits ORDER BY created_at DESC`
  )
  return rows
}

export async function findAuditById(auditId: string): Promise<AuditDetail | null> {
  const { rows } = await pool.query(
    `SELECT id, created_at, subscription_id,
            COALESCE(subscription_name, '') AS subscription_name,
            trigger_type, status,
            COALESCE(error_message, '') AS error_message,
            COALESCE(resource_counts, '{}'::jsonb) AS resource_counts,
            claude_analysis IS NOT NULL AS has_analysis,
            cost_data IS NOT NULL AS has_cost,
            usage_data IS NOT NULL AS has_usage,
            COALESCE(raw_data, '{}'::jsonb) AS raw_data,
            claude_analysis
     FROM audits WHERE id = $1`,
    [auditId]
  )
  return rows[0] || null
}

// findAuditRawData reads only raw_data — used by the region-summary
// endpoint, which needs the 12-resource-type inventory but not cost_data,
// usage_data, or claude_analysis (same column-isolation rationale as
// findAuditCostRaw/findAuditUsageRaw below).
export async function findAuditRawData(auditId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `SELECT raw_data FROM audits WHERE id = $1`,
    [auditId]
  )
  return rows[0]?.raw_data || null
}

// findAuditCostRaw reads cost_data + claude_analysis. cost_data is its own
// column (not nested in raw_data), so this never touches the 12-resource-type
// blob at all — fast regardless of how large raw_data has grown.
export async function findAuditCostRaw(auditId: string): Promise<AuditCostRaw | null> {
  const { rows } = await pool.query(
    `SELECT cost_data AS cost, claude_analysis FROM audits WHERE id = $1`,
    [auditId]
  )
  return rows[0] || null
}

// findAuditUsageRaw reads only usage_data — same isolation rationale as
// findAuditCostRaw.
export async function findAuditUsageRaw(auditId: string): Promise<UsageDataRaw | null> {
  const { rows } = await pool.query(
    `SELECT usage_data FROM audits WHERE id = $1`,
    [auditId]
  )
  return rows[0]?.usage_data || null
}

// findAuditCostUsageRaw is kept for callers that still need both at once
// (e.g. runAnalysis's "cost"/"usage" scopes) — two isolated columns, still
// far cheaper than touching raw_data.
export async function findAuditCostUsageRaw(auditId: string): Promise<AuditCostUsageRaw | null> {
  const { rows } = await pool.query(
    `SELECT cost_data AS cost, usage_data AS usage, claude_analysis FROM audits WHERE id = $1`,
    [auditId]
  )
  return rows[0] || null
}

export interface PreviousAuditCostUsage {
  cost: CostDataRaw | null
  usage: UsageDataRaw | null
  created_at: string
}

// Finds the most recent PRIOR audit of the SAME subscription (by
// created_at, same join shape as findSubscriptionFindingHistory in
// models/findings.ts) and returns its cost/usage columns — used for
// audit-over-audit cost/usage comparison ("$X this audit vs $Y last audit").
// Returns null if this is the subscription's first audit.
export async function findPreviousAuditCostUsageRaw(auditId: string): Promise<PreviousAuditCostUsage | null> {
  const { rows } = await pool.query(
    `SELECT prev.cost_data AS cost, prev.usage_data AS usage, prev.created_at
     FROM audits cur
     JOIN audits prev ON prev.subscription_id = cur.subscription_id AND prev.created_at < cur.created_at
     WHERE cur.id = $1
     ORDER BY prev.created_at DESC
     LIMIT 1`,
    [auditId]
  )
  return rows[0] || null
}

// The most recent PRIOR audit of the same subscription that has a
// status='done' analysis_requests row for this exact scope — i.e. the last
// audit whose analysis of this scope actually completed. Same "analyzed"
// definition as checkScopeCacheHit (models/analysisRequests.ts) and the Go
// CLI's PreviousAnalyzedScopeHash, so all three agree on what counts as a
// comparable prior audit (spec 14). Used to fetch that audit's already-saved
// analysis to carry forward instead of re-running it.
export async function findPreviousAnalyzedAuditId(auditId: string, scope: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT prev.id
     FROM audits cur
     JOIN audits prev ON prev.subscription_id = cur.subscription_id AND prev.created_at < cur.created_at
     WHERE cur.id = $1
       AND EXISTS (
         SELECT 1 FROM analysis_requests ar
         WHERE ar.audit_id = prev.id AND ar.scope = $2 AND ar.status = 'done'
       )
     ORDER BY prev.created_at DESC
     LIMIT 1`,
    [auditId, scope]
  )
  return rows[0]?.id || null
}

// Every resource-type scope this audit actually collected data for, mapped
// to its config hash (spec 14). Used by the "all"-scope parallel fan-out
// (spec 13 §Orchestration) to enumerate which scopes to cache-check —
// scopes with no entry here never collected data this audit and are
// skipped entirely, same as collect.go's own resourceCounts > 0 gate.
export async function findAuditScopeHashes(auditId: string): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT COALESCE(scope_hashes, '{}'::jsonb) AS scope_hashes FROM audits WHERE id = $1`,
    [auditId]
  )
  return rows[0]?.scope_hashes || {}
}

export async function findAuditResource(auditId: string, slug: string): Promise<unknown | null> {
  const { rows } = await pool.query(
    `SELECT raw_data -> $2 AS data FROM audits
     WHERE id = $1 AND raw_data IS NOT NULL`,
    [auditId, slug]
  )
  return rows[0]?.data || null
}

export async function updateClaudeAnalysis(auditId: string, analysis: object): Promise<void> {
  await pool.query(
    `UPDATE audits SET claude_analysis = $2 WHERE id = $1`,
    [auditId, JSON.stringify(analysis)]
  )
}

export async function insertAudit(
  subscriptionId: string,
  subscriptionName: string,
  triggerType: string
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO audits (subscription_id, subscription_name, trigger_type, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [subscriptionId, subscriptionName, triggerType]
  )
  return rows[0].id
}

export async function updateAudit(
  auditId: string,
  fields: { status?: string; error_message?: string; subscription_name?: string }
): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = [auditId]
  let i = 2
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status) }
  if (fields.error_message !== undefined) { sets.push(`error_message = $${i++}`); values.push(fields.error_message) }
  if (fields.subscription_name !== undefined) { sets.push(`subscription_name = $${i++}`); values.push(fields.subscription_name) }
  if (sets.length === 0) return false
  const { rowCount } = await pool.query(
    `UPDATE audits SET ${sets.join(', ')} WHERE id = $1`,
    values
  )
  return (rowCount ?? 0) > 0
}

export async function deleteAudit(auditId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM audits WHERE id = $1`, [auditId])
  return (rowCount ?? 0) > 0
}

export async function clearClaudeAnalysis(auditId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE audits SET claude_analysis = NULL WHERE id = $1`,
    [auditId]
  )
  return (rowCount ?? 0) > 0
}

export async function findAnalysisById(auditId: string): Promise<object | null> {
  const { rows } = await pool.query(
    `SELECT claude_analysis FROM audits WHERE id = $1`,
    [auditId]
  )
  if (!rows[0]) return null
  return rows[0].claude_analysis
}
