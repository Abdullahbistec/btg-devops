'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { Header } from '../../components/Header'
import { KPICard } from '../../components/KPICard'
import { CostTrendChart, formatCurrency } from '../../components/CostCharts'
import { FindingCard } from '../../components/AnalysisPanel'
import { KPISkeletonRow, ChartSkeleton } from '../../components/Skeleton'
import { resourceMeta } from '../../lib/resourceMeta'
import { api } from '../../lib/api'
import type { ResourceTypeSummary } from '../../types'
import type { DisplayFinding } from '../../lib/findingsLayout'

const SIGNAL_META: Record<'zombie' | 'spike' | 'idle', { label: string; cls: string }> = {
  zombie: { label: 'Zombie spend', cls: 'bdg-error' },
  spike:  { label: 'Spend spike',  cls: 'bdg-warning' },
  idle:   { label: 'Idle',         cls: 'bdg-muted' },
}

function TypePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const auditId = searchParams.get('auditId') || ''
  const type = searchParams.get('type') || ''

  const [summary, setSummary] = useState<ResourceTypeSummary | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<'overview' | 'individual'>('overview')
  const [selectedResourceId, setSelectedResourceId] = useState('')

  useEffect(() => {
    if (!auditId || !type) { setError('Missing auditId or type'); return }
    let cancelled = false
    api.getResourceTypeSummary(auditId, type)
      .then(data => { if (!cancelled) setSummary(data) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load resource type summary') })
    return () => { cancelled = true }
  }, [auditId, type])

  const backLink = (
    <Link href="/cost-usage" style={{
      fontSize: '0.78rem', color: 'var(--acc)', textDecoration: 'none',
      display: 'inline-flex', alignItems: 'center', gap: '0.3rem', marginRight: '0.5rem',
    }}>
      <ArrowLeft size={12} /> Back to Cost &amp; Usage
    </Link>
  )

  if (error) {
    return (
      <>
        <Header title="Resource Type" actions={backLink} />
        <div style={{ padding: '3rem 1.5rem', textAlign: 'center', color: '#ef4444', fontSize: '0.875rem' }}>{error}</div>
      </>
    )
  }

  if (!summary) {
    return (
      <>
        <Header title="Resource Type" actions={backLink} />
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <KPISkeletonRow />
          <ChartSkeleton />
        </div>
      </>
    )
  }

  const typeLabel = resourceMeta(summary.resource_type).label
  const findings: DisplayFinding[] = summary.findings.map(f => ({ ...f, category: f.category || '' }))

  function goToResource(resourceId: string) {
    if (!resourceId) return
    router.push(`/cost-usage/resource?auditId=${encodeURIComponent(auditId)}&resourceId=${encodeURIComponent(resourceId)}`)
  }

  return (
    <>
      <Header
        breadcrumbs={[{ label: 'Cost & Usage', href: '/cost-usage' }, { label: typeLabel }]}
        actions={backLink}
      />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--t1)', margin: 0 }}>{typeLabel}</h1>
            <p style={{ fontSize: '0.8rem', color: 'var(--t3)', marginTop: '0.25rem' }}>
              {summary.resource_count} resource{summary.resource_count === 1 ? '' : 's'} of this type in the current audit
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.3rem', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '0.2rem' }}>
            <button
              onClick={() => setView('overview')}
              className={view === 'overview' ? 'bdg bdg-primary' : 'bdg bdg-muted'}
              style={{ border: 'none', cursor: 'pointer', padding: '0.4rem 0.85rem' }}
            >
              Combined Overview
            </button>
            <button
              onClick={() => setView('individual')}
              className={view === 'individual' ? 'bdg bdg-primary' : 'bdg bdg-muted'}
              style={{ border: 'none', cursor: 'pointer', padding: '0.4rem 0.85rem' }}
            >
              Individual
            </button>
          </div>
        </div>

        {view === 'overview' ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard label="Total Cost" value={formatCurrency(summary.total_cost_usd, summary.currency)} sub="combined across this type" accent="emerald" />
              <KPICard label="Resources" value={summary.resource_count} sub="of this type" accent="violet" />
              <KPICard label="Flagged" value={summary.flagged_count} sub="zombie / spike / idle" accent="amber" />
              <KPICard label="Avg Utilization" value={summary.avg_utilization_pct !== null ? `${summary.avg_utilization_pct}%` : '—'} sub="where a utilization metric exists" accent="cyan" />
            </div>

            {summary.daily_cost.length > 0 && (
              <div className="glass" style={{ padding: '1.25rem' }}>
                <CostTrendChart dailyCost={summary.daily_cost} currency={summary.currency} />
              </div>
            )}

            <div className="glass" style={{ padding: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <Sparkles size={15} color="var(--acc)" />
                <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>AI Analysis for this type</h2>
              </div>
              {findings.length === 0 ? (
                <p style={{ fontSize: '0.82rem', color: 'var(--t3)' }}>No AI findings currently mention this resource type.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {findings.map((f, i) => (
                    <FindingCard key={f.id || i} f={f} canAnalyze={false} onToggleStatus={() => {}} />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="glass" style={{ padding: '1.25rem' }}>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t4)', marginBottom: '0.4rem' }}>
                Select a {typeLabel} resource
              </label>
              <select
                value={selectedResourceId}
                onChange={e => setSelectedResourceId(e.target.value)}
                style={{
                  width: '100%', maxWidth: 420, background: 'var(--input-bg)', border: '1px solid var(--border-strong)',
                  borderRadius: 8, color: 'var(--t1)', padding: '0.55rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer',
                }}
              >
                <option value="">— choose a resource —</option>
                {summary.resources.map(r => (
                  <option key={r.resource_id} value={r.resource_id}>
                    {r.resource_name} · {formatCurrency(r.total_cost_usd, summary.currency)}{r.signals.length ? ` · ${r.signals.map(s => SIGNAL_META[s].label).join(', ')}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {selectedResourceId ? (
              <button
                className="btn-primary"
                onClick={() => goToResource(selectedResourceId)}
              >
                View full details for this resource →
              </button>
            ) : (
              <p style={{ fontSize: '0.82rem', color: 'var(--t3)' }}>Pick a resource above to open its full cost, usage, and AI analysis.</p>
            )}
          </div>
        )}
      </div>
    </>
  )
}

export default function ResourceTypePage() {
  return (
    <Suspense fallback={<KPISkeletonRow />}>
      <TypePageInner />
    </Suspense>
  )
}
