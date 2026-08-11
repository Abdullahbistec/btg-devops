import pool from './client'

// Backs the MCP-server/Claude-Code-orchestrator flow (spec 8): the dashboard
// writes a pending row instead of calling an LLM API directly, a scheduled
// Claude Code agent claims it through the MCP server, and writes the result
// back via the existing updateClaudeAnalysis()/saveFindings() functions.

export interface AnalysisRequest {
  id: string
  audit_id: string
  scope: string
  status: 'pending' | 'done' | 'failed'
  error_message: string | null
  requested_at: Date
  completed_at: Date | null
  cache_hit: boolean
}

const REQUEST_COLS = `id, audit_id, scope, status, error_message, requested_at, completed_at, cache_hit`

export async function insertAnalysisRequest(auditId: string, scope: string, cacheHit = false): Promise<AnalysisRequest> {
  const { rows } = await pool.query(
    `INSERT INTO analysis_requests (audit_id, scope, cache_hit) VALUES ($1, $2, $3) RETURNING ${REQUEST_COLS}`,
    [auditId, scope, cacheHit]
  )
  return rows[0]
}

// Forces a real re-analysis of a scope after this many CONSECUTIVE cache
// hits (spec 14 A5) — protects against a hashing bug (or future data
// normalization) silently pinning stale findings forever, and lets
// playbook/checklist improvements eventually reach unchanged resources too.
// Keep in sync with the Go CLI's db.CacheStalenessCeiling
// (CLI Engine/internal/db/analysis_requests.go) — both sides must agree so
// a scope doesn't cache-hit indefinitely on one path while capped on the
// other.
const CACHE_STALENESS_CEILING = 7

// Counts how many of the most recent PRIOR audits of this subscription
// (going backward from auditId) have a cache_hit=true request for this exact
// scope, stopping at the first real (non-cached) analysis or once it
// reaches CACHE_STALENESS_CEILING.
async function trailingCacheHitStreak(auditId: string, scope: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT ar.cache_hit
     FROM analysis_requests ar
     JOIN audits a ON a.id = ar.audit_id
     WHERE a.subscription_id = (SELECT subscription_id FROM audits WHERE id = $1)
       AND a.created_at < (SELECT created_at FROM audits WHERE id = $1)
       AND ar.scope = $2
     ORDER BY a.created_at DESC
     LIMIT $3`,
    [auditId, scope, CACHE_STALENESS_CEILING]
  )
  let streak = 0
  for (const row of rows) {
    if (!row.cache_hit) break
    streak++
  }
  return streak
}

// True if `scope`'s config hash on this audit matches the hash on the most
// recent PRIOR audit of the same subscription that has a 'done' request for
// this same scope (spec 14 — per-scope analysis cache), AND the staleness
// ceiling hasn't been reached. Only meaningful for resource-type scopes —
// cost/usage/"all" have no entry in scope_hashes (by design, since cost/
// usage data changes every audit) and this always returns false for them,
// which is the correct "never cache" behavior.
export async function checkScopeCacheHit(auditId: string, scope: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT (cur.scope_hashes ->> $2) AS current_hash, (prev.scope_hashes ->> $2) AS prev_hash
     FROM audits cur
     LEFT JOIN LATERAL (
       SELECT a.scope_hashes
       FROM audits a
       WHERE a.subscription_id = cur.subscription_id
         AND a.created_at < cur.created_at
         AND EXISTS (
           SELECT 1 FROM analysis_requests ar
           WHERE ar.audit_id = a.id AND ar.scope = $2 AND ar.status = 'done'
         )
       ORDER BY a.created_at DESC
       LIMIT 1
     ) prev ON true
     WHERE cur.id = $1`,
    [auditId, scope]
  )
  const row = rows[0]
  if (!row || !row.current_hash || !row.prev_hash) return false
  if (row.current_hash !== row.prev_hash) return false

  const streak = await trailingCacheHitStreak(auditId, scope)
  return streak < CACHE_STALENESS_CEILING
}

// The most recent request for this audit+scope — callers use this to avoid
// enqueueing a duplicate while one is already pending, and to resolve what
// the frontend should poll right after the Analyze click.
export async function findLatestAnalysisRequest(auditId: string, scope: string): Promise<AnalysisRequest | null> {
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM analysis_requests
     WHERE audit_id = $1 AND scope = $2
     ORDER BY requested_at DESC LIMIT 1`,
    [auditId, scope]
  )
  return rows[0] || null
}

// The pending row a save_analysis() call should mark done — looked up by
// audit_id + scope rather than by id, since the MCP tool signature (per
// spec 8) is save_analysis(auditId, scope, ...), not save_analysis(requestId, ...).
export async function findPendingAnalysisRequest(auditId: string, scope: string): Promise<AnalysisRequest | null> {
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM analysis_requests
     WHERE audit_id = $1 AND scope = $2 AND status = 'pending'
     ORDER BY requested_at DESC LIMIT 1`,
    [auditId, scope]
  )
  return rows[0] || null
}

// Pending requests marked cache_hit=true (by either the Go auto-queue path
// or createAnalysisRequestController) — the analysis-cache resolver
// (utils/analysisCache.ts) claims these to carry findings forward instead of
// leaving them for the scheduled agent to spend a real pass on.
export async function findPendingCacheHitRequests(limit = 50): Promise<AnalysisRequest[]> {
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM analysis_requests
     WHERE status = 'pending' AND cache_hit = TRUE
     ORDER BY requested_at ASC LIMIT $1`,
    [limit]
  )
  return rows
}

export async function findAnalysisRequestById(id: string): Promise<AnalysisRequest | null> {
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM analysis_requests WHERE id = $1`,
    [id]
  )
  return rows[0] || null
}

// SQL fragment matching cost/usage scopes ('cost', 'usage', 'usage:<type>')
// for a given table alias's `scope` column — a function (not a plain
// string) because it's needed against two different aliases below, and a
// naive string.replace('scope', alias) would only touch the first of three
// occurrences.
function costUsageScopeSql(alias: string): string {
  return `(${alias}.scope = 'cost' OR ${alias}.scope = 'usage' OR ${alias}.scope LIKE 'usage:%')`
}

export function isCostOrUsageScope(scope: string): boolean {
  return scope === 'cost' || scope === 'usage' || scope.startsWith('usage:')
}

// Claimed by the MCP server's list_pending_requests() tool — oldest first,
// so a backlog drains in request order rather than last-in-first-served.
//
// Cost/usage scopes for an audit are deliberately held back (excluded here)
// as long as that SAME audit still has a pending non-cost/usage scope —
// cost/usage findings (idle resources, waste, chains) are most useful once
// the agent already has the full resource picture from analyzing the other
// 12 resource types, so they're queued last rather than racing in parallel.
// Once the last blocking scope resolves (done or failed), the cost/usage
// rows for that audit satisfy the NOT EXISTS below and become claimable.
export async function listPendingAnalysisRequests(limit = 20): Promise<AnalysisRequest[]> {
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM analysis_requests ar
     WHERE ar.status = 'pending'
       AND (
         NOT ${costUsageScopeSql('ar')}
         OR NOT EXISTS (
           SELECT 1 FROM analysis_requests blocker
           WHERE blocker.audit_id = ar.audit_id
             AND blocker.status = 'pending'
             AND NOT ${costUsageScopeSql('blocker')}
         )
       )
     ORDER BY ar.requested_at ASC LIMIT $1`,
    [limit]
  )
  return rows
}

// True the moment an audit's cost/usage scopes become claimable: every
// non-cost/usage scope has resolved (done or failed) AND at least one
// cost/usage scope is still pending. Used right after a non-cost/usage
// scope's save_analysis call to decide whether to wake the routine
// immediately instead of leaving newly-unblocked cost/usage requests to
// wait for its next cron tick.
export async function hasNewlyUnblockedCostUsage(auditId: string): Promise<boolean> {
  const isCostUsage = costUsageScopeSql('analysis_requests')
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending' AND NOT ${isCostUsage}) AS blocking_pending,
       COUNT(*) FILTER (WHERE status = 'pending' AND ${isCostUsage}) AS cost_usage_pending
     FROM analysis_requests WHERE audit_id = $1`,
    [auditId]
  )
  const { blocking_pending, cost_usage_pending } = rows[0]
  return Number(blocking_pending) === 0 && Number(cost_usage_pending) > 0
}

// True once every analysis_requests row for this audit has resolved
// (done or failed, none still pending) — the signal for sending the one
// consolidated "analysis complete" summary email, see auditSummaryEmail.ts.
export async function hasNoPendingForAudit(auditId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM analysis_requests WHERE audit_id = $1 AND status = 'pending'`,
    [auditId]
  )
  return rows[0].n === 0
}

export async function markAnalysisRequestDone(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE analysis_requests SET status = 'done', completed_at = NOW() WHERE id = $1`,
    [id]
  )
  return (rowCount ?? 0) > 0
}

export async function markAnalysisRequestFailed(id: string, errorMessage: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE analysis_requests SET status = 'failed', error_message = $2, completed_at = NOW() WHERE id = $1`,
    [id, errorMessage]
  )
  return (rowCount ?? 0) > 0
}

export interface AnalysisProgress {
  total: number
  done: number
  pending: number
  failed: number
  cached: number
  scopes: { scope: string; status: 'pending' | 'done' | 'failed'; cache_hit: boolean }[]
}

// Backs the dashboard's live "N of M resource types analyzed" progress bar
// AND its per-resource-type checklist for one audit — the request-per-scope
// rows already exist (queued by collect.go or a manual Analyze click), this
// just summarizes and lists them. cache_hit is surfaced (spec 14 A7) so the
// UI can show a scope was served from cache rather than freshly analyzed —
// without this, a "done" result for an unchanged scope would look identical
// to a fresh agent pass, which reads as suspiciously fast/shallow rather
// than as the cache working as intended.
export async function findAnalysisProgressForAudit(auditId: string): Promise<AnalysisProgress> {
  const { rows } = await pool.query(
    `SELECT scope, status, cache_hit FROM analysis_requests WHERE audit_id = $1 ORDER BY requested_at ASC`,
    [auditId]
  )
  const progress: AnalysisProgress = { total: rows.length, done: 0, pending: 0, failed: 0, cached: 0, scopes: rows }
  for (const row of rows) {
    progress[row.status as 'done' | 'pending' | 'failed']++
    if (row.cache_hit) progress.cached++
  }
  return progress
}
