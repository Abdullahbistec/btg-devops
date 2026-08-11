import pool from './client'
import { Finding } from '../types'

const FINDING_COLS = `id, audit_id, severity, category, resource_type, resource_name, resource_group,
            child_resource_name, affected_resources, cost_impact_usd, cost_impact_note, recommendation_steps,
            fix_effort, finding_type, issue, evidence, recommendation, scope, status, first_seen_at, resolved_at, created_at`

export async function findFindingsByAudit(auditId: string, scope?: string): Promise<Finding[]> {
  const params: unknown[] = [auditId]
  let where = `audit_id = $1`
  if (scope) {
    params.push(scope)
    where += ` AND scope = $2`
  }
  const { rows } = await pool.query(
    `SELECT ${FINDING_COLS}
     FROM findings WHERE ${where}
     ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'Warning' THEN 2 ELSE 3 END, created_at ASC`,
    params
  )
  return rows
}

// findFindingsByAuditAndResource narrows findFindingsByAudit's WHERE clause
// down to one resource by name — used by the resource-detail page so it
// shows only the AI findings that mention this resource, not the audit's
// full findings list.
export async function findFindingsByAuditAndResource(auditId: string, resourceName: string): Promise<Finding[]> {
  const { rows } = await pool.query(
    `SELECT ${FINDING_COLS}
     FROM findings WHERE audit_id = $1 AND resource_name = $2
     ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'Warning' THEN 2 ELSE 3 END, created_at ASC`,
    [auditId, resourceName]
  )
  return rows
}

// findFindingsByAuditAndResourceType narrows findFindingsByAudit down to one
// resource TYPE (the dashboard slug already stored on each finding, e.g.
// "cosmosdb") — used by the resource-type summary page to show findings
// combined across every resource of that type.
export async function findFindingsByAuditAndResourceType(auditId: string, resourceType: string): Promise<Finding[]> {
  const { rows } = await pool.query(
    `SELECT ${FINDING_COLS}
     FROM findings WHERE audit_id = $1 AND resource_type = $2
     ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'Warning' THEN 2 ELSE 3 END, created_at ASC`,
    [auditId, resourceType]
  )
  return rows
}

export async function insertFinding(
  auditId: string,
  finding: {
    severity: string; category?: string; resource_type: string; resource_name: string; resource_group?: string
    child_resource_name?: string; affected_resources?: string[]; cost_impact_usd?: number; cost_impact_note?: string
    recommendation_steps?: string[]; fix_effort?: string; finding_type?: string; issue: string; evidence?: string; recommendation: string
  },
  scope?: string,
  lifecycle?: { status?: string; firstSeenAt?: Date }
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO findings (audit_id, severity, category, resource_type, resource_name, resource_group,
                            child_resource_name, affected_resources, cost_impact_usd, cost_impact_note, recommendation_steps,
                            fix_effort, finding_type, issue, evidence, recommendation, scope, status, first_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
    [
      auditId, finding.severity, finding.category || null, finding.resource_type, finding.resource_name,
      finding.resource_group || null,
      finding.child_resource_name || null, finding.affected_resources || null,
      finding.cost_impact_usd ?? null, finding.cost_impact_note || null, finding.recommendation_steps || null,
      finding.fix_effort || null, finding.finding_type || null,
      finding.issue, finding.evidence || null, finding.recommendation, scope || null,
      lifecycle?.status || 'open', lifecycle?.firstSeenAt || new Date(),
    ]
  )
  return rows[0].id
}

// Deletes all findings previously saved for this exact scope on this audit —
// called right before inserting a fresh batch, so re-analyzing a scope
// replaces its old findings instead of accumulating duplicates alongside
// them. Rows from other scopes (or pre-scope-tracking legacy rows with a
// NULL scope) are untouched.
export async function deleteFindingsByScope(auditId: string, scope: string): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM findings WHERE audit_id = $1 AND scope = $2`,
    [auditId, scope]
  )
  return rowCount ?? 0
}

export interface PriorFinding {
  id: string
  resource_type: string
  resource_name: string
  category: string | null
  status: string
  first_seen_at: Date
}

// Live (open or dismissed) findings for the same subscription + scope from
// audits OLDER than the given one. Used by saveFindings to (a) carry each
// issue's original first_seen_at forward so age survives across audits,
// (b) keep dismissals sticky, and (c) auto-resolve issues that stopped
// appearing. Only older audits are considered so re-analyzing an old audit
// can't absorb or resolve findings that belong to a newer one.
export async function findPriorLiveFindings(auditId: string, scope: string): Promise<PriorFinding[]> {
  const { rows } = await pool.query(
    `SELECT f.id, f.resource_type, f.resource_name, f.category, f.status, f.first_seen_at
     FROM findings f
     JOIN audits a   ON a.id = f.audit_id
     JOIN audits cur ON cur.id = $1
     WHERE a.subscription_id = cur.subscription_id
       AND a.created_at < cur.created_at
       AND f.scope = $2
       AND f.status IN ('open', 'dismissed')`,
    [auditId, scope]
  )
  return rows
}

export async function deleteFindingsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const { rowCount } = await pool.query(`DELETE FROM findings WHERE id = ANY($1)`, [ids])
  return rowCount ?? 0
}

export async function resolveFindingsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const { rowCount } = await pool.query(
    `UPDATE findings SET status = 'resolved', resolved_at = NOW() WHERE id = ANY($1)`,
    [ids]
  )
  return rowCount ?? 0
}

export async function findTopFindings(limit: number): Promise<Finding[]> {
  const { rows } = await pool.query(
    `SELECT ${FINDING_COLS}
     FROM findings
     WHERE status = 'open'
     ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'Warning' THEN 2 ELSE 3 END, created_at DESC
     LIMIT $1`,
    [limit]
  )
  return rows
}

// Substring search over open findings for the dashboard search bar. LIKE
// metacharacters in the query are escaped so "100%" matches literally
// instead of acting as a wildcard.
export async function searchOpenFindings(q: string, limit: number): Promise<Finding[]> {
  const pattern = '%' + q.replace(/[%_\\]/g, '\\$&') + '%'
  const { rows } = await pool.query(
    `SELECT ${FINDING_COLS}
     FROM findings
     WHERE status = 'open' AND (issue ILIKE $1 OR resource_name ILIKE $1 OR resource_type ILIKE $1)
     ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'Warning' THEN 2 ELSE 3 END, created_at DESC
     LIMIT $2`,
    [pattern, limit]
  )
  return rows
}

// True the moment any finding has ever been recorded, regardless of status —
// distinguishes "nothing has been analyzed yet" from "everything open has
// since been resolved/dismissed" for the Top Issues empty state, which
// otherwise reads as if nothing was ever found even when the real story is
// "all clear."
export async function hasAnyFindings(): Promise<boolean> {
  const { rows } = await pool.query(`SELECT EXISTS(SELECT 1 FROM findings) AS has_rows`)
  return rows[0].has_rows
}

// Open-finding counts per audit, for the Recent Activity table's per-row
// severity indicator — one query for however many recent audits are shown
// rather than one round-trip per row.
export async function findSeverityCountsByAudits(
  auditIds: string[]
): Promise<Record<string, { critical: number; warning: number; info: number }>> {
  const out: Record<string, { critical: number; warning: number; info: number }> = {}
  for (const id of auditIds) out[id] = { critical: 0, warning: 0, info: 0 }
  if (auditIds.length === 0) return out

  const { rows } = await pool.query(
    `SELECT audit_id, severity, COUNT(*)::int AS count
     FROM findings
     WHERE audit_id = ANY($1) AND status = 'open'
     GROUP BY audit_id, severity`,
    [auditIds]
  )
  for (const row of rows) {
    const key = row.severity === 'Critical' ? 'critical' : row.severity === 'Warning' ? 'warning' : 'info'
    if (!out[row.audit_id]) out[row.audit_id] = { critical: 0, warning: 0, info: 0 }
    out[row.audit_id][key] = row.count
  }
  return out
}

export interface HistoryFinding {
  resource_type: string
  resource_name: string
  category: string | null
  severity: string
  status: string
  scope: string | null
  first_seen_at: Date
  resolved_at: Date | null
  audit_created_at: Date
}

// Every finding (any status — open, dismissed, resolved) across every past
// audit of the SAME subscription as auditId, oldest first. Backs the
// audit-history MCP tool (spec 10 §5.3/8.3) so the deep-research agent's
// Stage 4 ("judge in context") can see whether an issue has existed for
// multiple audits unresolved, or was already flagged and fixed/dismissed,
// instead of only ever seeing the current audit's snapshot. Deliberately
// broader than findPriorLiveFindings above (which only returns OPEN/
// DISMISSED rows strictly older than auditId, for the lifecycle-carry-
// forward logic in saveFindings) — history is read-only context for the
// agent's reasoning, not something that feeds back into a write path, so it
// includes resolved rows and the current audit too.
// scope is optional: omit it to see history across every scope (needed for
// a "deep" request, which has no single matching scope in prior audits from
// before this feature existed).
export async function findSubscriptionFindingHistory(
  auditId: string,
  scope?: string,
  limit = 300
): Promise<HistoryFinding[]> {
  const params: unknown[] = [auditId]
  let where = `a.subscription_id = cur.subscription_id AND a.created_at <= cur.created_at`
  if (scope) {
    params.push(scope)
    where += ` AND f.scope = $${params.length}`
  }
  params.push(limit)
  const { rows } = await pool.query(
    `SELECT f.resource_type, f.resource_name, f.category, f.severity, f.status, f.scope,
            f.first_seen_at, f.resolved_at, a.created_at AS audit_created_at
     FROM findings f
     JOIN audits a   ON a.id = f.audit_id
     JOIN audits cur ON cur.id = $1
     WHERE ${where}
     ORDER BY a.created_at ASC
     LIMIT $${params.length}`,
    params
  )
  return rows
}

export interface MonthlySavingsRow {
  month: string // YYYY-MM, month resolved_at falls in
  total_saved_usd: number
  findings_resolved: number
}

// Sums cost_impact_usd for findings that flipped to 'resolved' (saveFindings'
// auto-resolve — a cost-waste finding that no longer appears in a fresh
// analysis), grouped by month. Pure SQL aggregation over data the findings
// lifecycle already maintains — no estimation involved, since a finding is
// either resolved or it isn't and its cost_impact_usd was already set by the
// analysis that flagged it. subscriptionId narrows to one subscription;
// omit it for an org-wide total.
export async function findMonthlySavings(subscriptionId?: string, months = 12): Promise<MonthlySavingsRow[]> {
  const params: unknown[] = [months]
  let where = `f.status = 'resolved' AND f.resolved_at IS NOT NULL AND f.cost_impact_usd IS NOT NULL
               AND f.resolved_at >= date_trunc('month', now()) - ($1 || ' months')::interval`
  if (subscriptionId) {
    params.push(subscriptionId)
    where += ` AND a.subscription_id = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', f.resolved_at), 'YYYY-MM') AS month,
            SUM(f.cost_impact_usd) AS total_saved_usd,
            COUNT(*) AS findings_resolved
     FROM findings f
     JOIN audits a ON a.id = f.audit_id
     WHERE ${where}
     GROUP BY month
     ORDER BY month DESC`,
    params
  )
  return rows.map(r => ({
    month: r.month,
    total_saved_usd: Math.round(Number(r.total_saved_usd) * 100) / 100,
    findings_resolved: Number(r.findings_resolved),
  }))
}

export async function findFindingById(findingId: number): Promise<Finding | null> {
  const { rows } = await pool.query(
    `SELECT ${FINDING_COLS}
     FROM findings WHERE id = $1`,
    [findingId]
  )
  return rows[0] || null
}

export async function updateFinding(
  findingId: number,
  fields: { severity?: string; resource_type?: string; resource_name?: string; issue?: string; evidence?: string; recommendation?: string; status?: string }
): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = [findingId]
  let i = 2
  if (fields.severity !== undefined) { sets.push(`severity = $${i++}`); values.push(fields.severity) }
  if (fields.resource_type !== undefined) { sets.push(`resource_type = $${i++}`); values.push(fields.resource_type) }
  if (fields.resource_name !== undefined) { sets.push(`resource_name = $${i++}`); values.push(fields.resource_name) }
  if (fields.issue !== undefined) { sets.push(`issue = $${i++}`); values.push(fields.issue) }
  if (fields.evidence !== undefined) { sets.push(`evidence = $${i++}`); values.push(fields.evidence) }
  if (fields.recommendation !== undefined) { sets.push(`recommendation = $${i++}`); values.push(fields.recommendation) }
  if (fields.status !== undefined) {
    sets.push(`status = $${i++}`)
    values.push(fields.status)
    // resolved_at mirrors the status: stamped when resolved, cleared when reopened/dismissed.
    sets.push(fields.status === 'resolved' ? `resolved_at = NOW()` : `resolved_at = NULL`)
  }
  if (sets.length === 0) return false
  const { rowCount } = await pool.query(
    `UPDATE findings SET ${sets.join(', ')} WHERE id = $1`,
    values
  )
  return (rowCount ?? 0) > 0
}

export async function deleteFinding(findingId: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM findings WHERE id = $1`, [findingId])
  return (rowCount ?? 0) > 0
}
