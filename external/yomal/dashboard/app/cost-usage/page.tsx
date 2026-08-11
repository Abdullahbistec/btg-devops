'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, TrendingUp } from 'lucide-react'
import { Header } from '../components/Header'
import { KPICard } from '../components/KPICard'
import { AnalysisPanel } from '../components/AnalysisPanel'
import { ChatDock } from '../components/ChatDock'
import { CostTrendChart, TopServicesChart, formatCurrency } from '../components/CostCharts'
import { ZombieSpendList, SpendSpikesList, CostBreakdownTabs } from '../components/CostInsights'
import { ResourceSelector } from '../components/ResourceSelector'
import { KPISkeletonRow, ChartSkeleton } from '../components/Skeleton'
import { api } from '../lib/api'
import { shortId } from '../lib/utils'
import type { Audit, CostSummary } from '../types'

export default function CostUsagePage() {
  const [audit, setAudit]     = useState<Audit | null>(null)
  const [summary, setSummary] = useState<CostSummary | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError]     = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const audits = await api.listAudits()
        const latest = audits
          .filter(a => a.status === 'completed')
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
        if (!latest) {
          if (!cancelled) setNotFound(true)
          return
        }
        const summaryData = await api.getCostSummary(latest.id)
        if (!cancelled) {
          setAudit(latest)
          setSummary(summaryData)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load cost & usage data')
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <>
        <Header title="Cost & Usage" />
        <div style={{ padding: '3rem 1.5rem', textAlign: 'center', color: '#ef4444', fontSize: '0.875rem' }}>{error}</div>
      </>
    )
  }

  if (notFound) {
    return (
      <>
        <Header title="Cost & Usage" />
        <div className="glass" style={{ margin: '1.5rem', padding: '3rem 2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--t2)', fontSize: '0.9rem' }}>No completed audits yet.</p>
          <p style={{ color: 'var(--t3)', fontSize: '0.8rem', marginTop: '0.375rem' }}>
            Cost and usage data appears here once the first audit completes.
          </p>
        </div>
      </>
    )
  }

  if (!audit || !summary) {
    return (
      <>
        <Header title="Cost & Usage" />
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <KPISkeletonRow />
          <ChartSkeleton />
        </div>
      </>
    )
  }

  const hasCost = summary.daily_cost.length > 0
  const hasUsage = summary.usage_types.length > 0

  // Total Spend KPI tile shows THIS MONTH only, not the full multi-month
  // collected range (daily_cost/period_from/period_to can span ~90 days) —
  // scoped to the calendar month of the latest collected day (period_to),
  // since that's "the current audit's month" regardless of collection window.
  // Avg Daily Spend stays based on the full collected period, unaffected.
  const latestDate = summary.period_to || summary.daily_cost[summary.daily_cost.length - 1]?.date || ''
  const thisMonthKey = latestDate.slice(0, 7) // 'YYYY-MM'
  const thisMonthLabel = latestDate
    ? new Date(`${thisMonthKey}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : ''
  const monthCost = summary.daily_cost.filter(d => d.date.startsWith(thisMonthKey))
  const totalCost = monthCost.reduce((s, d) => s + d.cost, 0)
  const monthStart = monthCost[0]?.date || ''
  const monthEnd = monthCost[monthCost.length - 1]?.date || ''

  const fullTotalCost = summary.daily_cost.reduce((s, d) => s + d.cost, 0)
  const daySpan = (new Date(summary.period_to).getTime() - new Date(summary.period_from).getTime()) / 86400000 || 1
  const avgDaily = fullTotalCost / daySpan

  return (
    <>
      <Header
        title="Cost & Usage"
        actions={
          <Link href={`/audits/${audit.id}`} style={{
            fontSize: '0.78rem', color: 'var(--acc)', textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center', gap: '0.3rem', marginRight: '0.5rem',
          }}>
            View source audit ({shortId(audit.id)}) <ArrowRight size={12} />
          </Link>
        }
      />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <p style={{ fontSize: '0.78rem', color: 'var(--t3)' }}>
          Showing the latest completed audit's snapshot ({new Date(audit.created_at).toLocaleString()}, {audit.subscription_name || shortId(audit.subscription_id)})
          {summary.period_from && ` · period ${summary.period_from} to ${summary.period_to}`}
        </p>

        {!hasCost && !hasUsage ? (
          <div className="glass" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--t2)', fontSize: '0.9rem' }}>No cost or usage data in this audit yet.</p>
            <p style={{ color: 'var(--t3)', fontSize: '0.8rem', marginTop: '0.375rem' }}>
              Run <code>btg-devops collect</code> with the updated extractors to populate this page.
            </p>
          </div>
        ) : (
          <>
            {/* KPI tiles */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard
                label="Total Spend"
                value={hasCost ? formatCurrency(totalCost, summary.currency) : '—'}
                sub={hasCost ? (
                  <>
                    {thisMonthLabel}
                    <div style={{ marginTop: '0.15rem' }}>{monthStart} to {monthEnd}</div>
                  </>
                ) : 'no cost data'}
                accent="emerald"
              />
              <KPICard
                label="Avg Daily Spend"
                value={hasCost ? formatCurrency(avgDaily, summary.currency) : '—'}
                sub="based on actual cost"
                accent="cyan"
              />
              <KPICard
                label="Resources Sampled"
                value={summary.total_resources_sampled}
                sub="for usage metrics"
                accent="violet"
              />
              <KPICard
                label="30-Day Forecast"
                icon={TrendingUp}
                value={summary.signals.cost_forecast ? formatCurrency(summary.signals.cost_forecast.run_rate_next_30_days_usd, summary.currency) : '—'}
                trend={summary.signals.cost_forecast ? `${summary.signals.cost_forecast.trend_daily_delta_usd >= 0 ? '+' : ''}${formatCurrency(summary.signals.cost_forecast.trend_daily_delta_usd, summary.currency)}/day` : undefined}
                trendDir={summary.signals.cost_forecast && summary.signals.cost_forecast.trend_daily_delta_usd < 0 ? 'down' : 'up'}
                sub={summary.signals.cost_forecast
                  ? `trend-adjusted: ${formatCurrency(summary.signals.cost_forecast.trend_adjusted_next_30_days_usd, summary.currency)}`
                  : 'not enough cost history yet'}
                accent="amber"
              />
            </div>

            {/* Cost charts */}
            {hasCost && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="glass" style={{ padding: '1.25rem' }}>
                  <CostTrendChart dailyCost={summary.daily_cost} currency={summary.currency} />
                </div>
                <div className="glass" style={{ padding: '1.25rem' }}>
                  <TopServicesChart topServices={summary.top_services} currency={summary.currency} />
                </div>
              </div>
            )}

            {/* Deterministic cost signals — computed the same way as the LLM's
                precomputed_signals (see buildPrecomputedSignals in
                api/utils/claude.ts), shown directly instead of only through
                whatever the AI chooses to mention. */}
            {hasCost && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="glass" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <ZombieSpendList findings={summary.signals.zombie_spend} currency={summary.currency} />
                  <SpendSpikesList findings={summary.signals.spend_spikes} currency={summary.currency} />
                </div>
                <div className="glass" style={{ padding: '1.25rem' }}>
                  <CostBreakdownTabs
                    byResourceGroup={summary.signals.cost_by_resource_group}
                    byTag={summary.signals.cost_by_tag}
                    currency={summary.currency}
                  />
                </div>
              </div>
            )}

            {/* Jump to one resource's own cost/usage/AI-findings page, instead
                of hunting across the all-resources cards above. */}
            <ResourceSelector auditId={audit.id} resources={summary.resources} currency={summary.currency} />

            {/* AI Analysis — full width; chat lives in the floating ChatDock */}
            <AnalysisPanel
              auditId={audit.id}
              resourceCounts={{}}
              initialStore={summary.claude_analysis}
              hasCost={hasCost}
              usageTypes={summary.usage_types}
            />
          </>
        )}
      </div>

      {(hasCost || hasUsage) && (
        <ChatDock
          auditId={audit.id}
          hasCost={hasCost}
          usageTypes={summary.usage_types}
        />
      )}
    </>
  )
}
