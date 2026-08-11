'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Ghost, Zap, MoonStar, Sparkles } from 'lucide-react'
import { Header } from '../../components/Header'
import { KPICard } from '../../components/KPICard'
import { CostTrendChart, formatCurrency } from '../../components/CostCharts'
import { UsageTable } from '../../components/UsageTable'
import { FindingCard } from '../../components/AnalysisPanel'
import { KPISkeletonRow, ChartSkeleton } from '../../components/Skeleton'
import { resourceMeta } from '../../lib/resourceMeta'
import { api } from '../../lib/api'
import type { ResourceDetail } from '../../types'
import type { DisplayFinding } from '../../lib/findingsLayout'

function ReasonBox({ icon: Icon, tint, children }: { icon: React.ComponentType<{ size?: number; color?: string }>; tint: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: '0.625rem', alignItems: 'flex-start',
      background: 'var(--input-bg)', border: '1px solid var(--border)', borderLeft: `3px solid ${tint}`,
      borderRadius: 10, padding: '0.7rem 0.85rem', fontSize: '0.82rem', color: 'var(--t2)', lineHeight: 1.55,
    }}>
      <Icon size={15} color={tint} />
      <div>{children}</div>
    </div>
  )
}

function ResourcePageInner() {
  const searchParams = useSearchParams()
  const auditId = searchParams.get('auditId') || ''
  const resourceId = searchParams.get('resourceId') || ''

  const [detail, setDetail] = useState<ResourceDetail | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!auditId || !resourceId) { setError('Missing auditId or resourceId'); return }
    let cancelled = false
    api.getResourceDetail(auditId, resourceId)
      .then(data => { if (!cancelled) setDetail(data) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load resource detail') })
    return () => { cancelled = true }
  }, [auditId, resourceId])

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
        <Header title="Resource" actions={backLink} />
        <div style={{ padding: '3rem 1.5rem', textAlign: 'center', color: '#ef4444', fontSize: '0.875rem' }}>{error}</div>
      </>
    )
  }

  if (!detail) {
    return (
      <>
        <Header title="Resource" actions={backLink} />
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <KPISkeletonRow />
          <ChartSkeleton />
        </div>
      </>
    )
  }

  const typeLabel = detail.resource_type ? resourceMeta(detail.resource_type).label : 'Resource'
  const findings: DisplayFinding[] = detail.findings.map(f => ({ ...f, category: f.category || '' }))

  return (
    <>
      <Header
        breadcrumbs={[{ label: 'Cost & Usage', href: '/cost-usage' }, { label: detail.resource_name }]}
        actions={backLink}
      />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--t1)', margin: 0 }}>{detail.resource_name}</h1>
            <p style={{ fontSize: '0.78rem', color: 'var(--t4)', fontFamily: 'ui-monospace, monospace', marginTop: '0.25rem' }}>{detail.resource_id}</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ fontSize: '0.8rem', color: 'var(--t3)' }}>
              {typeLabel}{detail.resource_group ? ` · ${detail.resource_group}` : ''}
            </p>
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {detail.zombie && <span className="bdg bdg-error">Zombie spend</span>}
              {detail.spend_spikes.length > 0 && <span className="bdg bdg-warning">Spend spike</span>}
              {detail.idle.length > 0 && <span className="bdg bdg-muted">Idle</span>}
              {!detail.zombie && detail.spend_spikes.length === 0 && detail.idle.length === 0 && (
                <span className="bdg bdg-muted">No active signals</span>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <KPICard label="Total Cost" value={formatCurrency(detail.total_cost_usd, detail.currency)} sub="over the collected period" accent="emerald" />
          <KPICard label="Avg Daily Cost" value={formatCurrency(detail.avg_daily_cost_usd, detail.currency)} sub="based on actual cost" accent="cyan" />
          <KPICard label="Metrics Sampled" value={detail.usage_metrics.length} sub="usage metrics for this resource" accent="violet" />
        </div>

        {(detail.zombie || detail.spend_spikes.length > 0 || detail.idle.length > 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {detail.zombie && (
              <ReasonBox icon={Ghost} tint="var(--bad)">
                <b style={{ color: 'var(--t1)' }}>Zombie spend</b> — still billing under {detail.zombie.last_service_name || 'an unknown service'},
                {' '}{formatCurrency(detail.zombie.total_cost_usd, detail.currency)} across {detail.zombie.billed_days} billed days
                {' '}({detail.zombie.first_cost_date} → {detail.zombie.last_cost_date}), but this resource no longer appears in the audit's inventory.
              </ReasonBox>
            )}
            {detail.spend_spikes.map((s, i) => (
              <ReasonBox key={i} icon={Zap} tint="var(--warn)">
                <b style={{ color: 'var(--t1)' }}>Spend spike</b> on {s.spike_date}: {formatCurrency(s.spike_amount_usd, detail.currency)} vs
                {' '}a baseline of {formatCurrency(s.baseline_daily_avg_usd, detail.currency)}/day
                {' '}({s.flat_baseline ? 'flat baseline, 3× multiple' : `z-score ${s.z_score}`}).
              </ReasonBox>
            ))}
            {detail.idle.map((idle, i) => (
              <ReasonBox key={i} icon={MoonStar} tint="var(--t4)">
                <b style={{ color: 'var(--t1)' }}>Idle</b> — {idle.reason}
              </ReasonBox>
            ))}
          </div>
        )}

        {detail.daily_cost.length > 0 && (
          <div className="glass" style={{ padding: '1.25rem' }}>
            <CostTrendChart dailyCost={detail.daily_cost} currency={detail.currency} />
          </div>
        )}

        {detail.usage_metrics.length > 0 && (
          <div className="glass" style={{ padding: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
              <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>Usage Metrics</h2>
            </div>
            <UsageTable groups={[{ resource_id: detail.resource_id, metrics: detail.usage_metrics }]} />
          </div>
        )}

        <div className="glass" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <Sparkles size={15} color="var(--acc)" />
            <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>AI Analysis for this resource</h2>
          </div>
          {findings.length === 0 ? (
            <p style={{ fontSize: '0.82rem', color: 'var(--t3)' }}>No AI findings currently mention this resource.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {findings.map((f, i) => (
                <FindingCard key={f.id || i} f={f} canAnalyze={false} onToggleStatus={() => {}} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default function ResourceDetailPage() {
  return (
    <Suspense fallback={<KPISkeletonRow />}>
      <ResourcePageInner />
    </Suspense>
  )
}
