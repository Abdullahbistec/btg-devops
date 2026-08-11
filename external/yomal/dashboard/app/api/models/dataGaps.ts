import pool from './client'
import { DataGapEntry, ResolvedGapEntry } from '../types'
import { findAllDataGapMarks, DataGapMark } from './dataGapMarks'

interface ScopeRun {
  auditId: string
  generatedAt: string
  gaps: string[]
}

interface DataGapsView {
  open: DataGapEntry[]
  resolved: ResolvedGapEntry[]
}

// findDataGaps aggregates every audit's cached claude_analysis into a full
// run history per (subscription, scope), then combines it with any manual
// "mark as fixed" (dataGapMarks.ts) to produce two lists:
//
//  - open: the LATEST run for a scope still reports a gap. Split into three
//    verification_status values: 'open' (never marked), 'pending_verification'
//    (marked, but no analysis has run since — outcome not yet known), and
//    'reopened' (marked, but a LATER analysis still found a gap — the fix
//    didn't hold).
//  - resolved: marked, and a LATER analysis confirms zero gaps for that scope.
//
// This is a pure read over the existing claude_analysis JSONB column plus
// the small data_gap_marks table; "latest per scope" (not "every gap ever
// reported") is deliberate — a later run with zero gaps must make the gap
// disappear from `open` entirely, since this reflects what's still true
// today, not a history log.
export async function findDataGaps(): Promise<DataGapsView> {
  const { rows } = await pool.query(
    `SELECT id, subscription_id, COALESCE(subscription_name, '') AS subscription_name,
            created_at, claude_analysis
     FROM audits
     WHERE claude_analysis IS NOT NULL
     ORDER BY subscription_id, created_at DESC`
  )

  // subscription_id -> scope -> run history, newest first (guaranteed by the
  // ORDER BY above: rows for one subscription are contiguous and DESC by date).
  const bySubscription = new Map<string, Map<string, ScopeRun[]>>()
  const subscriptionNames = new Map<string, string>()

  for (const row of rows) {
    subscriptionNames.set(row.subscription_id, row.subscription_name)

    const store = (row.claude_analysis || {}) as {
      all?: { generated_at?: string; data_gaps?: string[] }
      by_resource?: Record<string, { generated_at?: string; data_gaps?: string[] }>
      data_gaps?: string[]
      generated_at?: string
    }

    const scopeEntries: [string, { generated_at?: string; data_gaps?: string[] }][] = []
    if (store.all) scopeEntries.push(['all', store.all])
    else if (store.data_gaps || store.generated_at) scopeEntries.push(['all', store])
    for (const [scope, analysis] of Object.entries(store.by_resource || {})) {
      // 'deep' is a legacy alias of 'all' (claude.ts's getScopedAuditData
      // treats them identically) — normalize here too, otherwise a stale
      // pre-rename 'deep' analysis would look permanently "open" since no
      // future run ever writes back to that exact key again.
      scopeEntries.push([scope === 'deep' ? 'all' : scope, analysis])
    }

    let scopeMap = bySubscription.get(row.subscription_id)
    if (!scopeMap) {
      scopeMap = new Map()
      bySubscription.set(row.subscription_id, scopeMap)
    }

    for (const [scope, analysis] of scopeEntries) {
      let history = scopeMap.get(scope)
      if (!history) {
        history = []
        scopeMap.set(scope, history)
      }
      history.push({
        auditId: row.id,
        generatedAt: analysis.generated_at || row.created_at,
        gaps: Array.isArray(analysis.data_gaps) ? analysis.data_gaps : [],
      })
    }
  }

  const marksByKey = new Map<string, DataGapMark>()
  for (const mark of await findAllDataGapMarks()) {
    marksByKey.set(`${mark.subscription_id}|${mark.scope}`, mark)
  }

  const open: DataGapEntry[] = []
  const resolved: ResolvedGapEntry[] = []

  for (const [subscriptionId, scopeMap] of bySubscription.entries()) {
    for (const [scope, history] of scopeMap.entries()) {
      const latest = history[0]
      if (!latest) continue

      const mark = marksByKey.get(`${subscriptionId}|${scope}`)
      const subscriptionName = subscriptionNames.get(subscriptionId) || ''

      if (latest.gaps.length === 0) {
        // Nothing open right now. If it was ever marked, and this run
        // (or an earlier one after the mark) is what confirmed it clean,
        // surface it as a recently-resolved entry.
        if (mark) {
          resolved.push({
            subscription_id: subscriptionId,
            subscription_name: subscriptionName,
            scope,
            marked_at: mark.marked_at,
            marked_by_email: mark.marked_by_email,
            note: mark.note,
            resolved_at: latest.generatedAt,
          })
        }
        continue
      }

      let consecutiveRuns = 0
      for (const run of history) {
        if (run.gaps.length === 0) break
        consecutiveRuns++
      }

      let verificationStatus: DataGapEntry['verification_status'] = 'open'
      if (mark) {
        // A run counts as "since the mark" if it's strictly newer — the
        // mark is applied AFTER seeing a report, so equal timestamps can't
        // happen in practice, but > keeps the comparison unambiguous.
        verificationStatus = new Date(latest.generatedAt) > new Date(mark.marked_at)
          ? 'reopened'
          : 'pending_verification'
      }

      open.push({
        subscription_id: subscriptionId,
        subscription_name: subscriptionName,
        scope,
        gaps: latest.gaps,
        audit_id: latest.auditId,
        generated_at: latest.generatedAt,
        consecutive_runs: consecutiveRuns,
        verification_status: verificationStatus,
        mark: mark
          ? { marked_at: mark.marked_at, marked_by_email: mark.marked_by_email, note: mark.note }
          : undefined,
      })
    }
  }

  // Reopened first (a fix attempt failed — highest priority), then longest-
  // open, then most recently seen.
  const statusRank = { reopened: 0, open: 1, pending_verification: 2 }
  open.sort((a, b) =>
    statusRank[a.verification_status] - statusRank[b.verification_status] ||
    b.consecutive_runs - a.consecutive_runs ||
    (a.generated_at < b.generated_at ? 1 : -1)
  )
  resolved.sort((a, b) => (a.resolved_at < b.resolved_at ? 1 : -1))

  return { open, resolved }
}
