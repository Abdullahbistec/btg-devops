'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Lock, AlertCircle, AlertTriangle, Info, TriangleAlert, EyeOff, RotateCcw, RefreshCw, Download, Share2, FileText, FileSpreadsheet, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { Badge } from './Badge'
import { Modal } from './Modal'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { buildScopeGroups, scopeLabel, firstScope, UsageTypeInfo } from '../lib/scopes'
import { severityConfig, findingStatusConfig, findingAge } from '../lib/utils'
import { exportFindingsAsExcel, exportFindingsAsPDF } from '../lib/exportFindings'
import { isAccountBasedType, type DisplayFinding } from '../lib/findingsLayout'
import { FindingsGroupFlat, IssueCard } from './FindingsGroupFlat'
import { FindingsGroupAccount } from './FindingsGroupAccount'
import { EvidenceBlock } from './EvidenceBlock'
import type { Finding, User } from '../types'

// The LLM output shape (a subset of DisplayFinding, without the DB-only
// lifecycle fields) — what a freshly-run or cached analysis returns.
type AnalysisFinding = Omit<DisplayFinding, 'id' | 'status' | 'first_seen_at'>

export interface Analysis {
  summary: string
  findings: AnalysisFinding[]
  generated_at: string
  model: string
  // Deep-research only (spec 10 §5.4/§6) — data the agent needed but
  // couldn't get, recorded so it becomes the next round of extractor work.
  data_gaps?: string[]
}

export interface AnalysisStore {
  all?: Analysis
  by_resource?: Record<string, Analysis>
}

const ALL_SCOPE = 'all'
// Every Analyze scope now always runs the full 5-stage deep-research
// process (spec 10 §4) — there is no separate fast/one-shot mode and no
// dedicated "deep" scope to pick anymore (superseded the earlier standalone
// DEEP_SCOPE option). getScopedAuditData still accepts scope 'deep' as a
// backward-compat alias of 'all' for any analysis saved before this change.
const POLL_INTERVAL_MS = 7000

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeStore(raw: unknown): AnalysisStore {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  if ('all' in obj || 'by_resource' in obj) return obj as AnalysisStore
  if ('findings' in obj) return { all: obj as unknown as Analysis } // legacy flat shape
  return {}
}

const severityIcons = {
  Critical: <AlertCircle size={15} color="#ef4444" />,
  Warning:  <AlertTriangle size={15} color="#fbbf24" />,
  Info:     <Info size={15} color="#38bdf8" />,
}

const severityTint = {
  Critical: { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.35)',  color: '#ef4444' },
  Warning:  { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.35)', color: '#fbbf24' },
  Info:     { bg: 'rgba(56,189,248,0.1)', border: 'rgba(56,189,248,0.35)', color: '#38bdf8' },
}

// Extracted so the same card renders identically whether grouped by
// resource group or shown as a flat list.
export function FindingCard({ f, canAnalyze, onToggleStatus }: {
  f: DisplayFinding
  canAnalyze: boolean
  onToggleStatus: (id: string, status: 'open' | 'dismissed') => void
}) {
  const sc = severityConfig[f.severity] || { label: f.severity, color: 'muted' }
  const age = f.first_seen_at ? findingAge(f.first_seen_at) : null
  const st = f.status && f.status !== 'open' ? findingStatusConfig[f.status] : null
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: '0.875rem 1rem',
      background: 'var(--input-bg)',
      opacity: f.status === 'dismissed' ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        {severityIcons[f.severity]}
        <Badge color={sc.color} label={sc.label} />
        {f.category && <Badge color="muted" label={f.category} />}
        {age && <Badge color={age.color} label={age.label} />}
        {st && <Badge color={st.color} label={st.label} />}
        <span style={{
          marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--t4)',
          fontFamily: 'ui-monospace, monospace',
        }}>
          {f.resource_type}{f.resource_name ? ` · ${f.resource_name}` : ''}
        </span>
        {canAnalyze && f.id && f.status !== 'resolved' && (
          <button
            onClick={() => onToggleStatus(f.id!, f.status === 'dismissed' ? 'open' : 'dismissed')}
            title={f.status === 'dismissed' ? 'Reopen this finding' : "Dismiss (won't fix / accepted risk)"}
            style={{
              background: 'none', border: '1px solid var(--border-strong)', borderRadius: 6,
              color: 'var(--t3)', padding: '0.2rem 0.35rem', cursor: 'pointer', display: 'flex',
            }}
          >
            {f.status === 'dismissed' ? <RotateCcw size={12} /> : <EyeOff size={12} />}
          </button>
        )}
      </div>
      <p style={{ fontSize: '0.82rem', color: 'var(--t1)', lineHeight: 1.55 }}>{f.issue}</p>
      <EvidenceBlock evidence={f.evidence} />
      {f.recommendation && (
        <div style={{
          marginTop: '0.625rem', padding: '0.55rem 0.75rem', borderRadius: 6,
          background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)',
          fontSize: '0.78rem', color: 'var(--t2)', lineHeight: 1.5,
        }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>Fix: </span>
          {f.recommendation}
        </div>
      )}
    </div>
  )
}

interface AnalysisPanelProps {
  auditId: string
  resourceCounts: Record<string, number>
  initialStore: unknown
  hasCost?: boolean
  usageTypes?: UsageTypeInfo[]
  // Reports the currently-selected Analyze scope to the parent page, so the
  // Raw Resource Data section below can show only the type being analyzed
  // instead of all 12 at once.
  onScopeChange?: (scope: string) => void
}

export function AnalysisPanel({ auditId, resourceCounts, initialStore, hasCost = false, usageTypes = [], onScopeChange }: AnalysisPanelProps) {
  const { user } = useAuth()
  const canAnalyze = user?.role === 'admin' || user?.role === 'analyst'

  const resourceTypes = useMemo(() => Object.keys(resourceCounts || {}).sort(), [resourceCounts])
  const scopeGroups = useMemo(
    () => buildScopeGroups(resourceCounts, hasCost, usageTypes),
    [resourceCounts, hasCost, usageTypes]
  )

  const [store, setStore] = useState<AnalysisStore>(() => normalizeStore(initialStore))
  const [scope, setScope] = useState<string>(() => firstScope(scopeGroups) || ALL_SCOPE)
  useEffect(() => { onScopeChange?.(scope) }, [scope, onScopeChange])
  const [running, setRunning]   = useState(false)
  const [error, setError]       = useState('')
  const [showAllConfirm, setShowAllConfirm] = useState(false)
  const [sevFilter, setSevFilter]   = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [shareRoles, setShareRoles]     = useState<string[]>([])
  const [shareUserIds, setShareUserIds] = useState<string[]>([])
  const [shareUsers, setShareUsers]     = useState<User[] | null>(null)
  const [shareSending, setShareSending] = useState(false)
  const [shareError, setShareError]     = useState('')
  const [shareDone, setShareDone]       = useState<number | null>(null)

  const currentAnalysis = scope === ALL_SCOPE ? store.all : store.by_resource?.[scope]

  // DB-backed findings for the current scope — these carry lifecycle fields
  // (status, first_seen_at) the cached-analysis JSON doesn't have. Tagged
  // with the scope they were fetched for so a stale response can't render
  // under a different scope.
  const [dbFindings, setDbFindings] = useState<{ scope: string; rows: Finding[] } | null>(null)
  const pollCancelRef = useRef<(() => void) | null>(null)
  // True when the most recently completed Analyze click was served from the
  // per-scope cache (spec 14 — this scope's config hasn't changed since the
  // last analyzed audit, so the prior findings were carried forward instead
  // of a fresh agent pass). Distinct from the "Cached" badge below, which
  // means something unrelated (an analysis result already exists to view).
  const [servedFromCache, setServedFromCache] = useState(false)

  useEffect(() => {
    if (!currentAnalysis) return
    let cancelled = false
    api.listFindings(auditId, scope)
      .then(rows => { if (!cancelled) setDbFindings({ scope, rows }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [auditId, scope, currentAnalysis])

  // Stops an in-flight poll loop if the panel unmounts (e.g. navigating away
  // mid-analysis) so it doesn't keep calling setState after the fact.
  useEffect(() => () => pollCancelRef.current?.(), [])

  // Analyze now queues a request for the scheduled Claude Code agent (spec 8)
  // instead of calling an LLM directly from this request, and polls until
  // the agent (via the MCP server) writes a result back. cancelledRef lets
  // an in-flight poll loop stop itself if the component unmounts mid-poll.
  function applyAnalysisResult(slug: string, analysis: Analysis) {
    setStore(s =>
      slug === ALL_SCOPE
        ? { ...s, all: analysis }
        : { ...s, by_resource: { ...(s.by_resource || {}), [slug]: analysis } }
    )
    api.listFindings(auditId, slug).then(rows => setDbFindings({ scope: slug, rows })).catch(() => {})
  }

  async function analyzeScope(slug: string) {
    setRunning(true)
    setError('')
    setServedFromCache(false)
    let cancelled = false
    const stop = () => { cancelled = true }
    pollCancelRef.current = stop
    try {
      const { requestId, status, cacheHit } = await api.requestAnalysis(auditId, slug)
      let current = status
      if (cacheHit) setServedFromCache(true)

      // A cache hit (spec 14) resolves synchronously and can already be
      // 'done' on this very first response — fetch and render it now
      // instead of falling into the poll loop below, which only ever
      // checks status AFTER the request was still 'pending'.
      if (current === 'done') {
        const poll = await api.getAnalysisRequest(auditId, requestId)
        if (poll.analysis) applyAnalysisResult(slug, poll.analysis as unknown as Analysis)
      }

      while (current === 'pending' && !cancelled) {
        await sleep(POLL_INTERVAL_MS)
        if (cancelled) break
        const poll = await api.getAnalysisRequest(auditId, requestId)
        current = poll.status
        if (poll.cacheHit) setServedFromCache(true)
        if (current === 'done' && poll.analysis) {
          applyAnalysisResult(slug, poll.analysis as unknown as Analysis)
        } else if (current === 'failed') {
          setError(poll.error_message || 'Analysis failed')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed')
    } finally {
      if (!cancelled) setRunning(false)
    }
  }

  function handleAnalyzeClick() {
    if (scope === ALL_SCOPE) setShowAllConfirm(true)
    else analyzeScope(scope)
  }

  async function setFindingStatus(id: string, status: 'open' | 'dismissed') {
    try {
      await api.updateFinding(auditId, id, { status })
      setDbFindings(d => d && { ...d, rows: d.rows.map(r => (r.id === id ? { ...r, status } : r)) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status update failed')
    }
  }

  const currentScopeLabel = scope === ALL_SCOPE ? 'All Resources' : scopeLabel(scope, scopeGroups)

  // Exports exactly what's currently on screen (respecting the active
  // severity/type filters), not the full unfiltered scope — filtering to
  // Critical and hitting Export should not silently include everything.
  function handleExport(format: 'pdf' | 'excel') {
    setShowExportMenu(false)
    if (!currentAnalysis) return
    const meta = {
      auditId,
      scopeLabel: currentScopeLabel,
      summary: currentAnalysis.summary || '',
      generatedAt: currentAnalysis.generated_at,
    }
    if (format === 'excel') exportFindingsAsExcel(filtered, meta)
    else exportFindingsAsPDF(filtered, meta)
  }

  function openShareModal() {
    setShowShareModal(true)
    setShareError('')
    setShareDone(null)
    if (user?.role === 'admin' && !shareUsers) {
      api.listUsers().then(setShareUsers).catch(() => setShareUsers([]))
    }
  }

  function toggleShareRole(role: string) {
    setShareRoles(r => r.includes(role) ? r.filter(x => x !== role) : [...r, role])
  }

  function toggleShareUser(id: string) {
    setShareUserIds(u => u.includes(id) ? u.filter(x => x !== id) : [...u, id])
  }

  async function sendShare() {
    setShareSending(true)
    setShareError('')
    try {
      const result = await api.shareAnalysis(auditId, scope, shareRoles, shareUserIds)
      setShareDone(result.recipientCount)
      setShareRoles([])
      setShareUserIds([])
    } catch (e) {
      setShareError(e instanceof Error ? e.message : 'Failed to share')
    } finally {
      setShareSending(false)
    }
  }

  const findings: DisplayFinding[] = useMemo(() => {
    if (dbFindings && dbFindings.scope === scope && dbFindings.rows.length > 0) {
      return dbFindings.rows.map(r => ({
        id: r.id,
        severity: r.severity,
        category: r.category || '',
        resource_type: r.resource_type,
        resource_name: r.resource_name,
        resource_group: r.resource_group,
        child_resource_name: r.child_resource_name,
        affected_resources: r.affected_resources,
        cost_impact_usd: r.cost_impact_usd,
        cost_impact_note: r.cost_impact_note,
        recommendation_steps: r.recommendation_steps,
        fix_effort: r.fix_effort,
        finding_type: r.finding_type,
        issue: r.issue,
        evidence: r.evidence,
        recommendation: r.recommendation,
        status: r.status,
        first_seen_at: r.first_seen_at,
      }))
    }
    return currentAnalysis?.findings || []
  }, [dbFindings, scope, currentAnalysis])
  const counts = {
    Critical: findings.filter(f => f.severity === 'Critical').length,
    Warning:  findings.filter(f => f.severity === 'Warning').length,
    Info:     findings.filter(f => f.severity === 'Info').length,
  }
  const findingResourceTypes = useMemo(
    () => Array.from(new Set(findings.map(f => f.resource_type).filter(Boolean))).sort(),
    [findings]
  )
  const filtered = findings.filter(f =>
    (sevFilter === 'all' || f.severity === sevFilter) &&
    (typeFilter === 'all' || f.resource_type === typeFilter)
  )
  const hasActiveFilter = sevFilter !== 'all' || typeFilter !== 'all'

  // Quick wins (spec 10, Phase 3) — Critical/Warning findings that are also
  // cheap to fix (fix_effort='quick'), surfaced ahead of the full findings
  // list so severity ("how bad") and effort ("how cheap to fix") triage
  // together instead of only via the raw severity tiles. Computed from the
  // full (unfiltered) scope findings, not `filtered` — a user filtering
  // down to Info shouldn't make this section disappear/reappear on them.
  const [quickWinsOpen, setQuickWinsOpen] = useState(true)
  const quickWins = useMemo(
    () => findings.filter(f => (f.severity === 'Critical' || f.severity === 'Warning') && f.fix_effort === 'quick'),
    [findings]
  )

  // Chain/headline findings (spec 10 §4 Stage 3, §5.4) — deep-research
  // findings reasoned across multiple resources into one real attack path
  // (finding_type='chain'). Rendered as its own section at the very top of
  // the results, above severity tiles and Quick wins — it IS the deep-
  // research strategy's main output. Like Quick wins, a chain finding also
  // still appears in the regular layout below (same highlight-without-
  // hiding precedent), so filtering the page down never makes it disappear
  // entirely.
  const chainFindings = useMemo(() => findings.filter(f => f.finding_type === 'chain'), [findings])

  // Which findings layout to render (analysis-ui spec): a single specific
  // resource-type scope gets the account (Cosmos DB/Storage/App Service
  // Plan) or flat-by-issue layout; "all"/"cost"/"usage:<type>" scopes span
  // multiple/no single resource type, so they keep the resource-group
  // grouping instead — the two groupings are different axes (account/child
  // vs. Azure resource group) and don't compete for the same scope.
  const layoutMode: 'account' | 'flat-issue' | 'resource-group' =
    scope !== ALL_SCOPE && resourceTypes.includes(scope)
      ? (isAccountBasedType(scope) ? 'account' : 'flat-issue')
      : 'resource-group'

  // Group by resource group when at least one finding actually has one —
  // scopes like "cost"/"usage"/"all" or pre-migration findings often won't,
  // so falling back to a flat list keeps those views unchanged.
  const UNGROUPED = 'No resource group'
  const hasResourceGroups = filtered.some(f => f.resource_group)
  const groupedFindings = useMemo(() => {
    if (!hasResourceGroups) return null
    const groups = new Map<string, DisplayFinding[]>()
    for (const f of filtered) {
      const key = f.resource_group || UNGROUPED
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(f)
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === UNGROUPED) return 1
      if (b === UNGROUPED) return -1
      return a.localeCompare(b)
    })
  }, [filtered, hasResourceGroups])
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  function toggleGroup(key: string) {
    setCollapsedGroups(s => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectStyle: React.CSSProperties = {
    background: 'var(--panel)', border: '1px solid var(--border-strong)',
    borderRadius: 8, color: 'var(--t1)', padding: '0.4rem 0.625rem', fontSize: '0.78rem',
    cursor: 'pointer', maxWidth: '100%',
  }

  return (
    <div className="glass" style={{ padding: '1.25rem' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem', flexWrap: 'wrap' }}>
        <Sparkles size={16} color="var(--acc)" />
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>AI Analysis</h2>
        {currentAnalysis && (
          <Badge color="success" label={`Cached · ${currentScopeLabel} · ${new Date(currentAnalysis.generated_at).toLocaleDateString()}`} />
        )}
        {servedFromCache && !running && (
          <span title="This scope's configuration is unchanged since the last analyzed audit — the prior findings were reused instead of running a fresh analysis.">
            <Badge color="info" label="No changes since last audit" />
          </span>
        )}
        {currentAnalysis && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', position: 'relative' }}>
            {canAnalyze && (
              <button
                className="btn-ghost"
                disabled={running}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.75rem', fontSize: '0.78rem' }}
                onClick={handleAnalyzeClick}
                title="Run a fresh analysis for this scope, replacing the cached result"
              >
                <RefreshCw size={13} /> Re-run
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <button
                className="btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.75rem', fontSize: '0.78rem' }}
                onClick={() => setShowExportMenu(v => !v)}
              >
                <Download size={13} /> Export{hasActiveFilter ? ` (${filtered.length})` : ''}
              </button>
              {showExportMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={() => setShowExportMenu(false)} />
                  <div style={{
                    position: 'absolute', top: '110%', right: 0, zIndex: 10,
                    background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.25)', minWidth: 140, overflow: 'hidden',
                  }}>
                    <button
                      onClick={() => handleExport('pdf')}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.55rem 0.75rem', background: 'none', border: 'none', color: 'var(--t1)', fontSize: '0.8rem', cursor: 'pointer', textAlign: 'left' }}
                    >
                      <FileText size={14} /> PDF
                    </button>
                    <button
                      onClick={() => handleExport('excel')}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.55rem 0.75rem', background: 'none', border: 'none', color: 'var(--t1)', fontSize: '0.8rem', cursor: 'pointer', textAlign: 'left' }}
                    >
                      <FileSpreadsheet size={14} /> Excel
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              className="btn-ghost"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.75rem', fontSize: '0.78rem' }}
              onClick={openShareModal}
            >
              <Share2 size={13} /> Share
            </button>
          </div>
        )}
      </div>

      {/* scope selector — always visible so viewers can browse cached results too */}
      {scopeGroups.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.78rem', color: 'var(--t3)' }}>Analyze:</label>
          <select
            style={selectStyle}
            value={scope}
            onChange={e => setScope(e.target.value)}
            disabled={running}
          >
            {scopeGroups.map(g => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </optgroup>
            ))}
            {resourceTypes.length > 0 && (
              <option value={ALL_SCOPE}>— All Resources (all {resourceTypes.length} types) —</option>
            )}
          </select>
        </div>
      )}

      {/* state: viewer locked, no analysis for this scope */}
      {!currentAnalysis && !canAnalyze && (
        <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--t3)' }}>
          <Lock size={22} style={{ margin: '0 auto 0.75rem', display: 'block' }} />
          <p style={{ fontSize: '0.85rem' }}>Analysis has not been run yet for this selection.</p>
          <p style={{ fontSize: '0.78rem', marginTop: '0.25rem' }}>Ask an analyst or admin to run it.</p>
        </div>
      )}

      {/* state: can run, not yet run for this scope */}
      {!currentAnalysis && canAnalyze && !running && (
        <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--t2)', marginBottom: '1rem' }}>
            {scope === ALL_SCOPE
              ? 'Queue a deep, multi-stage investigation of the full audit (all resource types) — maps the environment, correlates cost/usage/config, and chains issues into real attack paths instead of a single-pass sweep.'
              : resourceTypes.includes(scope)
              ? `Queue a deep, multi-stage investigation of the "${scope}" resources.`
              : `Queue a deep, multi-stage investigation of the ${scopeLabel(scope, scopeGroups)}.`}
          </p>
          {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{error}</p>}
          <button className="btn-primary" onClick={handleAnalyzeClick}>Analyze</button>
        </div>
      )}

      {/* state: running */}
      {running && (
        <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
          <div style={{
            width: 26, height: 26, margin: '0 auto 0.875rem',
            border: '2px solid var(--border-strong)', borderTopColor: 'var(--acc)',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          }} />
          <p style={{ fontSize: '0.82rem', color: 'var(--t2)' }}>
            {scope === ALL_SCOPE ? 'Full audit queued for analysis…' : `${scopeLabel(scope, scopeGroups)} queued for analysis…`}
          </p>
          <p style={{ fontSize: '0.72rem', color: 'var(--t4)', marginTop: '0.25rem' }}>
            A scheduled agent works through a multi-stage investigation — this can take longer than a quick check.
          </p>
        </div>
      )}

      {/* state: results */}
      {currentAnalysis && !running && (
        <div className="animate-fade-in">
          {currentAnalysis.summary && (
            <p style={{ fontSize: '0.83rem', color: 'var(--t2)', lineHeight: 1.6, marginBottom: '1rem' }}>
              {currentAnalysis.summary}
            </p>
          )}

          {/* Investigated (chain) findings — deep research's main output (spec 10 §4 Stage 3) */}
          {chainFindings.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
              {chainFindings.map((f, i) => (
                <div key={f.id || `chain-${i}`} style={{ border: '1px solid rgba(239,68,68,0.5)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.875rem',
                    background: 'rgba(239,68,68,0.12)', borderBottom: '1px solid rgba(239,68,68,0.3)',
                  }}>
                    <TriangleAlert size={14} color="#ef4444" />
                    <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Investigated finding {chainFindings.length > 1 ? `#${i + 1}` : ''}
                    </span>
                  </div>
                  <div style={{ padding: '0.125rem' }}>
                    <IssueCard f={f} canAnalyze={canAnalyze} onToggleStatus={setFindingStatus} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Data gaps — deep research only (spec 10 §5.5/§6 feedback loop) */}
          {currentAnalysis.data_gaps && currentAnalysis.data_gaps.length > 0 && (
            <div style={{
              marginBottom: '1.25rem', padding: '0.7rem 0.875rem', borderRadius: 8,
              border: '1px solid var(--border-strong)', background: 'var(--panel)',
            }}>
              <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--t2)', marginBottom: '0.4rem' }}>
                Data gaps — the agent could not verify:
              </p>
              <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                {currentAnalysis.data_gaps.map((gap, i) => (
                  <li key={i} style={{ fontSize: '0.76rem', color: 'var(--t3)', lineHeight: 1.5 }}>{gap}</li>
                ))}
              </ul>
            </div>
          )}

          {/* severity tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.625rem', marginBottom: '1rem' }}>
            {(['Critical', 'Warning', 'Info'] as const).map(sev => {
              const t = severityTint[sev]
              const active = sevFilter === sev
              return (
                <button
                  key={sev}
                  onClick={() => setSevFilter(active ? 'all' : sev)}
                  style={{
                    background: t.bg,
                    border: `1px solid ${active ? t.color : t.border}`,
                    borderRadius: 8, padding: '0.75rem', cursor: 'pointer', textAlign: 'center',
                    outline: active ? `1px solid ${t.color}` : 'none',
                  }}
                >
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, color: t.color, fontFamily: 'ui-monospace, monospace' }}>
                    {counts[sev]}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {sev}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Quick wins — Critical/Warning findings that are also cheap to fix (spec 10 Phase 3) */}
          {quickWins.length > 0 && (
            <div style={{
              marginBottom: '1rem', borderRadius: 8, overflow: 'hidden',
              border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.05)',
            }}>
              <button
                onClick={() => setQuickWinsOpen(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                  padding: '0.7rem 0.875rem', border: 'none', cursor: 'pointer', textAlign: 'left', background: 'none',
                }}
              >
                {quickWinsOpen ? <ChevronDown size={14} color="#22c55e" /> : <ChevronRight size={14} color="#22c55e" />}
                <Zap size={14} color="#22c55e" />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)' }}>
                  Quick wins
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--t3)' }}>
                  {quickWins.length} issue{quickWins.length === 1 ? '' : 's'} you can fix right now
                </span>
              </button>
              {quickWinsOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', padding: '0 0.875rem 0.875rem' }}>
                  {quickWins.map((f, i) => (
                    <IssueCard key={f.id || `qw-${i}`} f={f} canAnalyze={canAnalyze} onToggleStatus={setFindingStatus} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* filter bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem', flexWrap: 'wrap' }}>
            <select style={selectStyle} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="all">All resource types</option>
              {findingResourceTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select style={selectStyle} value={sevFilter} onChange={e => setSevFilter(e.target.value)}>
              <option value="all">All priorities</option>
              <option value="Critical">Critical</option>
              <option value="Warning">Warning</option>
              <option value="Info">Info</option>
            </select>
            {hasActiveFilter && (
              <button
                onClick={() => { setSevFilter('all'); setTypeFilter('all') }}
                style={{ background: 'none', border: 'none', color: 'var(--acc)', fontSize: '0.78rem', cursor: 'pointer' }}
              >
                Clear filters
              </button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--t3)' }}>
              {filtered.length} of {findings.length} findings
            </span>
          </div>

          {/* findings — layout depends on scope: account→child, flat-by-issue, or resource-group */}
          {filtered.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--t3)', fontSize: '0.82rem', padding: '1.5rem 0' }}>
              No findings match the selected filters.
            </p>
          ) : layoutMode === 'account' ? (
            <FindingsGroupAccount findings={filtered} canAnalyze={canAnalyze} onToggleStatus={setFindingStatus} />
          ) : layoutMode === 'flat-issue' ? (
            <FindingsGroupFlat findings={filtered} canAnalyze={canAnalyze} onToggleStatus={setFindingStatus} />
          ) : groupedFindings ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {groupedFindings.map(([groupName, groupFindings]) => {
                const collapsed = collapsedGroups.has(groupName)
                return (
                  <div key={groupName} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <button
                      onClick={() => toggleGroup(groupName)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                        padding: '0.6rem 0.75rem', background: 'var(--panel)', border: 'none',
                        cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      {collapsed ? <ChevronRight size={14} color="var(--t3)" /> : <ChevronDown size={14} color="var(--t3)" />}
                      <span style={{
                        fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', fontWeight: 600,
                        color: groupName === UNGROUPED ? 'var(--t3)' : 'var(--t1)',
                      }}>
                        {groupName}
                      </span>
                      <span className="bdg bdg-muted" style={{ marginLeft: 'auto' }}>{groupFindings.length}</span>
                    </button>
                    {!collapsed && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', padding: '0.75rem' }}>
                        {groupFindings.map((f, i) => (
                          <FindingCard key={f.id || i} f={f} canAnalyze={canAnalyze} onToggleStatus={setFindingStatus} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {filtered.map((f, i) => (
                <FindingCard key={f.id || i} f={f} canAnalyze={canAnalyze} onToggleStatus={setFindingStatus} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* "Analyze All" confirmation dialog */}
      {showAllConfirm && (
        <Modal title="Analyze All Resources?" onClose={() => setShowAllConfirm(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{
              display: 'flex', gap: '0.625rem', padding: '0.75rem 0.875rem',
              background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8,
            }}>
              <TriangleAlert size={17} color="#fbbf24" style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ fontSize: '0.82rem', color: 'var(--t2)', lineHeight: 1.55 }}>
                This queues the complete audit dataset — all {resourceTypes.length} resource types — as a single analysis request.
                It takes longer for the agent to work through than analyzing one resource type at a time.
              </p>
            </div>
            {error && <p style={{ color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}
            <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end' }}>
              <button className="btn-ghost" onClick={() => setShowAllConfirm(false)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={() => { setShowAllConfirm(false); analyzeScope(ALL_SCOPE) }}
              >
                Yes, Analyze All
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Share dialog */}
      {showShareModal && (
        <Modal title={`Share "${currentScopeLabel}" Analysis`} onClose={() => setShowShareModal(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {shareDone !== null ? (
              <p style={{ fontSize: '0.85rem', color: '#22c55e' }}>
                Sent to {shareDone} recipient{shareDone === 1 ? '' : 's'}.
              </p>
            ) : (
              <>
                <div>
                  <p style={{ fontSize: '0.78rem', color: 'var(--t3)', marginBottom: '0.5rem' }}>Share with role:</p>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    {['admin', 'analyst', 'viewer'].map(role => (
                      <label key={role} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', color: 'var(--t2)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={shareRoles.includes(role)} onChange={() => toggleShareRole(role)} />
                        {role}
                      </label>
                    ))}
                  </div>
                </div>

                {user?.role === 'admin' && (
                  <div>
                    <p style={{ fontSize: '0.78rem', color: 'var(--t3)', marginBottom: '0.5rem' }}>Or specific users:</p>
                    {!shareUsers ? (
                      <p style={{ fontSize: '0.78rem', color: 'var(--t4)' }}>Loading users…</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', maxHeight: 160, overflowY: 'auto' }}>
                        {shareUsers.map(u => (
                          <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--t2)', cursor: 'pointer' }}>
                            <input type="checkbox" checked={shareUserIds.includes(u.id)} onChange={() => toggleShareUser(u.id)} />
                            {u.email} <span style={{ color: 'var(--t4)', fontSize: '0.72rem' }}>({u.role})</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {shareError && <p style={{ color: '#ef4444', fontSize: '0.8rem' }}>{shareError}</p>}

                <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end' }}>
                  <button className="btn-ghost" onClick={() => setShowShareModal(false)}>Cancel</button>
                  <button
                    className="btn-primary"
                    disabled={shareSending || (shareRoles.length === 0 && shareUserIds.length === 0)}
                    onClick={sendShare}
                  >
                    {shareSending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
