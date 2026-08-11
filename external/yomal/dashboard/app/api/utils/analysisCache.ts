import { getAnalysisForScope, saveAnalysisResult, type ClaudeAnalysis } from './claude'
import { findPreviousAnalyzedAuditId, findAuditScopeHashes } from '../models/audit'
import { findPendingCacheHitRequests, markAnalysisRequestDone, checkScopeCacheHit } from '../models/analysisRequests'

// Carries a scope's analysis forward from the most recent PRIOR audit whose
// analysis of this exact scope completed, without spending any agent/LLM
// time (spec 14 — per-scope analysis cache). Reuses saveAnalysisResult, so
// the findings lifecycle (age carry-forward, sticky dismissals, auto-
// resolve) behaves exactly as it would for a fresh analysis that happened
// to find the same things again — which is the truth here, it just didn't
// need to look. Returns false (does nothing) if there's no usable prior
// analysis to copy — the caller should leave the request pending so the
// agent still processes it normally rather than losing the analysis.
export async function carryForwardCachedAnalysis(auditId: string, scope: string): Promise<boolean> {
  const prevAuditId = await findPreviousAnalyzedAuditId(auditId, scope)
  if (!prevAuditId) return false
  const prevAnalysis = await getAnalysisForScope(prevAuditId, scope)
  if (!prevAnalysis) return false
  await saveAnalysisResult(auditId, scope, prevAnalysis)
  return true
}

// Resolves every currently-pending cache_hit request (up to `limit`) by
// carrying its findings forward. Called right before the MCP server's
// list_pending_requests responds, so a cached scope never even appears as
// work for the scheduled agent to spend time on. Best-effort per row: a
// carry-forward failure just leaves that row pending — it falls back to a
// normal agent-analyzed request rather than the analysis silently vanishing.
export async function resolveCachedAnalysisRequests(limit = 50): Promise<number> {
  const pending = await findPendingCacheHitRequests(limit)
  let resolved = 0
  for (const req of pending) {
    try {
      if (await carryForwardCachedAnalysis(req.audit_id, req.scope)) {
        await markAnalysisRequestDone(req.id)
        resolved++
      }
    } catch (e) {
      console.warn(`[analysis-cache] carry-forward failed for ${req.audit_id}/${req.scope}:`, e instanceof Error ? e.message : e)
    }
  }
  return resolved
}

export interface ScopeChangeStatus {
  scope: string
  changed: boolean
}

// Used by the "all"-scope parallel fan-out (spec 13 §Orchestration, B5/B6)
// to decide which resource-type scopes collected in this audit need a
// per-type agent spawned, vs. which can be carried forward from a prior
// audit with no agent at all. Reuses checkScopeCacheHit — the exact same
// definition a normal single-scope request uses — so "changed" here can
// never disagree with what a standalone request would compute for the same
// scope. "all" requests never went through per-request cache_hit tracking
// (spec 14 explicitly skips scope="all"), so this is a fresh, read-only
// check rather than reading a stored flag.
export async function listChangedScopes(auditId: string): Promise<ScopeChangeStatus[]> {
  const hashes = await findAuditScopeHashes(auditId)
  const scopes = Object.keys(hashes)
  const results: ScopeChangeStatus[] = []
  for (const scope of scopes) {
    const cacheHit = await checkScopeCacheHit(auditId, scope)
    results.push({ scope, changed: !cacheHit })
  }
  return results
}

// Returns the prior audit's already-saved analysis for a scope
// listChangedScopes reported as unchanged, without the caller (an agent
// inside the "all" fan-out) ever needing to know which audit ID that was.
// Returns null if there's no usable prior analysis — the caller should fall
// back to spawning a real per-type agent for that scope rather than
// treating a cache hit as "nothing to report".
export async function getCachedScopeAnalysis(auditId: string, scope: string): Promise<ClaudeAnalysis | null> {
  const prevAuditId = await findPreviousAnalyzedAuditId(auditId, scope)
  if (!prevAuditId) return null
  const analysis = await getAnalysisForScope(prevAuditId, scope)
  return analysis || null
}
