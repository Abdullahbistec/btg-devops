'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Check, ArrowLeftRight, Play, Loader2, X, Circle } from 'lucide-react'
import { Header } from '../components/Header'
import { Badge } from '../components/Badge'
import { TableSkeleton } from '../components/Skeleton'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { shortId, statusConfig, triggerConfig } from '../lib/utils'
import type { Audit } from '../types'

// How long after clicking "Run Audit" to keep polling for the new audit row
// to appear and complete, before giving up and telling the user to check
// back later. Collection across 12 resource types + cost/usage realistically
// takes a few minutes; this is a generous upper bound, not an expected time.
const RUN_AUDIT_POLL_MS = 5000
const RUN_AUDIT_TIMEOUT_MS = 10 * 60 * 1000

// Mirrors the exact order collect.go runs extractors + cost + usage in
// (cmd/collect.go's allExtractors slice, then cost, then usage) — current_step
// values like "extracting acr (4/14)" are parsed against this list to render
// a live checklist instead of just the raw string.
const COLLECTION_STEPS: { key: string; label: string }[] = [
  { key: 'storage', label: 'Storage Accounts' },
  { key: 'iam', label: 'IAM Role Assignments' },
  { key: 'nsg', label: 'Network Security Groups' },
  { key: 'acr', label: 'Container Registries' },
  { key: 'cosmosdb', label: 'Cosmos DB' },
  { key: 'keyvault', label: 'Key Vaults' },
  { key: 'functions', label: 'Function Apps' },
  { key: 'appservice', label: 'App Services' },
  { key: 'appserviceplan', label: 'App Service Plans' },
  { key: 'publicip', label: 'Public IP Addresses' },
  { key: 'cognitiveservices', label: 'Cognitive Services' },
  { key: 'resourcegroup', label: 'Resource Groups' },
  { key: 'cdn', label: 'CDN / Front Door' },
  { key: 'vm', label: 'Virtual Machines' },
  { key: 'inventory', label: 'Full Resource Inventory' },
  { key: 'cost', label: 'Cost Management' },
  { key: 'usage', label: 'Azure Monitor Usage' },
]

// Parses "extracting acr (4/14)" -> 4. Returns 0 (nothing done yet) if the
// step string doesn't match, e.g. right when the audit row is first created.
function parseStepIndex(step: string | null): number {
  if (!step) return 0
  const m = step.match(/\((\d+)\/(\d+)\)/)
  return m ? parseInt(m[1], 10) : 0
}

type StepStatus = 'done' | 'active' | 'pending' | 'failed'

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') return <Check size={13} style={{ color: '#22c55e' }} />
  if (status === 'failed') return <X size={13} style={{ color: '#ef4444' }} />
  if (status === 'active') return <Loader2 size={13} style={{ color: 'var(--acc)', animation: 'spin 0.8s linear infinite' }} />
  return <Circle size={8} style={{ color: 'var(--t4)' }} />
}

function StepRow({ label, status }: { label: string; status: StepStatus }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0' }}>
      <div style={{ width: 14, display: 'flex', justifyContent: 'center' }}><StepIcon status={status} /></div>
      <span style={{
        fontSize: '0.78rem',
        color: status === 'done' ? 'var(--t2)' : status === 'active' ? 'var(--t1)' : status === 'failed' ? '#ef4444' : 'var(--t4)',
        fontWeight: status === 'active' ? 600 : 400,
      }}>
        {label}
      </span>
    </div>
  )
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: 'var(--acc)', transition: 'width 0.4s ease' }} />
    </div>
  )
}

const PAGE_SIZE = 10

function countsSummary(a: Audit): string {
  const entries = Object.entries(a.resource_counts || {})
    .filter(([, n]) => n > 0)
    .sort(([, x], [, y]) => y - x)
  if (entries.length === 0) return '—'
  const top = entries.slice(0, 3).map(([k, n]) => `${k}: ${n}`).join(', ')
  return entries.length > 3 ? `${top}, …` : top
}

type RunState = 'idle' | 'starting' | 'waiting' | 'done' | 'failed' | 'timeout' | 'error'

export default function AuditsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const [audits, setAudits]   = useState<Audit[] | null>(null)
  const [error, setError]     = useState('')
  const [status, setStatus]   = useState('all')
  const [trigger, setTrigger] = useState('all')
  const [dateRange, setDateRange] = useState('all')
  const [page, setPage]       = useState(1)

  const [runState, setRunState] = useState<RunState>('idle')
  const [runError, setRunError] = useState('')
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const triggeredAtRef = useRef<string | null>(null)

  function refreshAudits() {
    return api.listAudits().then(setAudits).catch(e => setError(e instanceof Error ? e.message : 'Failed to load audits'))
  }

  useEffect(() => { refreshAudits() }, [])

  // Poll for the new manual audit to appear (by created_at after the click)
  // and finish, since GitHub's workflow_dispatch API doesn't hand back the
  // resulting audit's ID directly — we just watch our own audits table.
  // Shows current_step (e.g. "extracting acr (3/12)") live while it runs.
  // Stops at collection finishing — analysis timing is separate (scheduled
  // or manually triggered), not shown here, since it doesn't start right
  // after collection and tracking it here implied otherwise.
  useEffect(() => {
    if (runState !== 'waiting' || !triggeredAtRef.current) return
    const startedAt = Date.now()
    const triggeredAt = new Date(triggeredAtRef.current).getTime()

    const interval = setInterval(async () => {
      if (Date.now() - startedAt > RUN_AUDIT_TIMEOUT_MS) {
        setRunState('timeout')
        clearInterval(interval)
        return
      }
      const list = await api.listAudits().catch(() => null)
      if (!list) return
      setAudits(list)
      const started = list.find(a => a.trigger_type === 'manual' && new Date(a.created_at).getTime() >= triggeredAt)
      if (!started) return
      setCurrentStep(started.current_step)
      if (started.status !== 'running') {
        setRunState(started.status === 'completed' ? 'done' : 'failed')
        clearInterval(interval)
      }
    }, RUN_AUDIT_POLL_MS)

    return () => clearInterval(interval)
  }, [runState])

  async function handleRunAudit() {
    setRunState('starting')
    setRunError('')
    setCurrentStep(null)
    try {
      const result = await api.triggerAudit()
      triggeredAtRef.current = result.triggered_at
      setRunState('waiting')
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Failed to trigger audit')
      setRunState('error')
    }
  }

  const filtered = useMemo(() => {
    if (!audits) return []
    const now = new Date()
    return audits.filter(a => {
      if (status !== 'all' && a.status !== status) return false
      if (trigger !== 'all' && a.trigger_type !== trigger) return false
      if (dateRange !== 'all') {
        const d = new Date(a.created_at)
        const thisMonth = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        const prevMonth = d.getFullYear() === prev.getFullYear() && d.getMonth() === prev.getMonth()
        if (dateRange === 'this-month' && !thisMonth) return false
        if (dateRange === 'prev-month' && !prevMonth) return false
      }
      return true
    })
  }, [audits, status, trigger, dateRange])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function setFilter(setter: (v: string) => void) {
    return (v: string) => { setter(v); setPage(1) }
  }

  const selectStyle: React.CSSProperties = {
    background: 'var(--panel)', border: '1px solid var(--border-strong)',
    borderRadius: 8, color: 'var(--t1)', padding: '0.45rem 0.75rem', fontSize: '0.82rem',
    cursor: 'pointer',
  }

  return (
    <>
      <Header title="Audit History" />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        {/* filter bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
          <select style={selectStyle} value={status} onChange={e => setFilter(setStatus)(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
          </select>
          <select style={selectStyle} value={trigger} onChange={e => setFilter(setTrigger)(e.target.value)}>
            <option value="all">All triggers</option>
            <option value="scheduled">Scheduled</option>
            <option value="manual">Manual</option>
          </select>
          <select style={selectStyle} value={dateRange} onChange={e => setFilter(setDateRange)(e.target.value)}>
            <option value="all">All dates</option>
            <option value="this-month">This month</option>
            <option value="prev-month">Previous month</option>
          </select>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--t3)' }}>
              {filtered.length} audit{filtered.length === 1 ? '' : 's'}
            </span>
            <button
              className="btn-ghost"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.45rem 0.875rem', fontSize: '0.8rem' }}
              onClick={() => router.push('/audits/compare')}
            >
              <ArrowLeftRight size={14} /> Compare
            </button>
            {user?.role === 'admin' && (
              <button
                className="btn-ghost"
                disabled={runState === 'starting' || runState === 'waiting'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.45rem 0.875rem', fontSize: '0.8rem' }}
                onClick={handleRunAudit}
              >
                {runState === 'starting' || runState === 'waiting'
                  ? <Loader2 size={14} style={{ animation: "spin 0.8s linear infinite" }} />
                  : <Play size={14} />}
                Run Audit
              </button>
            )}
          </div>
        </div>

        {runState !== 'idle' && (() => {
          const stepIndex = parseStepIndex(currentStep) // 0 when not yet started
          const collectionDone = runState === 'done'
          const collectionFailed = runState === 'failed'
          const collectionPct = collectionDone ? 100 : (stepIndex / COLLECTION_STEPS.length) * 100

          return (
            <div className="glass" style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: collectionFailed ? '#ef4444' : 'var(--t1)' }}>
                  {collectionFailed ? 'Audit failed' : runState === 'starting' ? 'Starting audit…' : collectionDone ? 'Audit complete' : 'Collecting Azure resource data'}
                </span>
                {(runState === 'done' || collectionFailed || runState === 'timeout' || runState === 'error') && (
                  <button
                    className="btn-ghost"
                    style={{ marginLeft: 'auto', padding: '0.25rem 0.625rem', fontSize: '0.75rem' }}
                    onClick={() => setRunState('idle')}
                  >
                    Dismiss
                  </button>
                )}
              </div>

              {runState === 'error' && <span style={{ fontSize: '0.8rem', color: '#ef4444' }}>Could not start audit: {runError}</span>}
              {runState === 'timeout' && <span style={{ fontSize: '0.8rem', color: 'var(--t2)' }}>Still running after 10 minutes — check back later; this page stopped polling but the audit may still finish.</span>}

              {runState !== 'error' && (
                <>
                  <ProgressBar pct={collectionPct} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 1rem' }}>
                    {COLLECTION_STEPS.map((s, i) => {
                      const n = i + 1
                      const st: StepStatus = collectionFailed && n === stepIndex ? 'failed'
                        : collectionDone || n < stepIndex ? 'done'
                        : n === stepIndex ? 'active' : 'pending'
                      return <StepRow key={s.key} label={s.label} status={st} />
                    })}
                  </div>
                </>
              )}

              {collectionDone && (
                <span style={{ fontSize: '0.8rem', color: 'var(--t3)' }}>
                  Analysis requests have been queued — results appear once the scheduled analyzer (1:30 PM daily) or a manual trigger processes them.
                </span>
              )}
            </div>
          )
        })()}

        {error && (
          <div className="glass" style={{ padding: '1.5rem', textAlign: 'center', color: '#ef4444', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}

        {!audits && !error && <TableSkeleton rows={8} cols={8} />}

        {audits && filtered.length === 0 && (
          <div className="glass" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--t2)', fontSize: '0.875rem' }}>No audits match these filters.</p>
            <p style={{ color: 'var(--t3)', fontSize: '0.78rem', marginTop: '0.375rem' }}>
              Audits run daily at 1:30 PM Sri Lanka time.
            </p>
          </div>
        )}

        {audits && filtered.length > 0 && (
          <div className="glass" style={{ padding: '0.5rem 1.25rem 1rem' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Audit ID', 'Subscription', 'Date & Time', 'Trigger', 'Status', 'Resource Counts', 'Analysis', ''].map(h => (
                      <th key={h} style={{
                        textAlign: 'left', padding: '0.625rem 0.75rem',
                        fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.06em',
                        textTransform: 'uppercase', color: 'var(--t3)',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(a => {
                    const sc = statusConfig[a.status]   || { label: a.status, color: 'muted' }
                    const tc = triggerConfig[a.trigger_type] || { label: a.trigger_type, color: 'muted' }
                    return (
                      <tr
                        key={a.id}
                        className="row-hover"
                        style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onClick={() => router.push(`/audits/${a.id}`)}
                      >
                        <td style={{ padding: '0.625rem 0.75rem', fontFamily: 'ui-monospace, monospace', color: 'var(--acc)' }}>
                          {shortId(a.id)}
                        </td>
                        <td style={{ padding: '0.625rem 0.75rem', color: 'var(--t2)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.subscription_name || shortId(a.subscription_id)}
                        </td>
                        <td style={{ padding: '0.625rem 0.75rem', color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                          {new Date(a.created_at).toLocaleString()}
                        </td>
                        <td style={{ padding: '0.625rem 0.75rem' }}><Badge color={tc.color} label={tc.label} /></td>
                        <td style={{ padding: '0.625rem 0.75rem' }}><Badge color={sc.color} label={sc.label} /></td>
                        <td style={{ padding: '0.625rem 0.75rem', maxWidth: 260 }}>
                          {a.status === 'failed' ? (
                            <span style={{ color: '#ef4444', fontSize: '0.75rem', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {a.error_message || 'failed'}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--t3)', fontSize: '0.75rem' }}>{countsSummary(a)}</span>
                          )}
                        </td>
                        <td style={{ padding: '0.625rem 0.75rem' }}>
                          {a.has_analysis ? (
                            <span style={{ color: '#22c55e', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              <Check size={13} /> Yes
                            </span>
                          ) : (
                            <span style={{ color: 'var(--t4)', fontSize: '0.78rem' }}>No</span>
                          )}
                        </td>
                        <td style={{ padding: '0.625rem 0.75rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <span style={{ color: 'var(--acc)', fontSize: '0.78rem' }}>View Details</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* pagination */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem', paddingTop: '0.875rem' }}>
              <span style={{ fontSize: '0.78rem', color: 'var(--t3)' }}>Page {page} of {totalPages}</span>
              <button
                className="btn-ghost"
                style={{ padding: '0.3rem 0.5rem', display: 'flex' }}
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="btn-ghost"
                style={{ padding: '0.3rem 0.5rem', display: 'flex' }}
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
