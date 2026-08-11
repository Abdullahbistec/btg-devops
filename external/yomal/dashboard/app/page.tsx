'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Boxes, Database, ShieldAlert, Play, AlertTriangle } from 'lucide-react'
import { Header } from './components/Header'
import { KPICard } from './components/KPICard'
import { ResourceChart } from './components/ResourceChart'
import { KPISkeletonRow, ChartSkeleton, TableSkeleton } from './components/Skeleton'
import { TopIssues } from './components/TopIssues'
import { useRegionSummary, CrossRegionCheck } from './components/RegionSection'
import { SeverityDonut } from './components/SeverityDonut'
import { ResourceDeltaList } from './components/ResourceDeltaList'
import { MiniSeverityCard } from './components/MiniSeverityCard'
import { RecentAuditsCard, type SeverityCounts } from './components/RecentAuditsCard'
import { RegionListCard } from './components/RegionListCard'
import { SavingsCard } from './components/SavingsCard'
import { DashboardSearch } from './components/DashboardSearch'
import { api } from './lib/api'
import { useAuth } from './lib/auth'
import { shortId } from './lib/utils'
import type { Audit, Subscription } from './types'

function totalResources(a: Audit): number {
  return Object.values(a.resource_counts || {}).reduce((s, n) => s + n, 0)
}

export default function DashboardPage() {
  const { user } = useAuth()
  const [audits, setAudits]       = useState<Audit[] | null>(null)
  const [subs, setSubs]           = useState<Subscription[] | null>(null)
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const auditList = await api.listAudits()
      setAudits(auditList)
      if (user?.role === 'admin') {
        try { setSubs(await api.listSubscriptions()) } catch { setSubs(null) }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard data')
    } finally {
      setLoading(false)
    }
  }, [user?.role])

  useEffect(() => { load() }, [load])

  const completed = audits?.filter(a => a.status === 'completed') || []
  const latest   = completed[0] || null
  const previous = completed[1] || null
  const recent = audits?.slice(0, 5) || []
  // The newest audit that actually has an analysis — the severity donut and
  // stat cards show ITS numbers (labeled as such) instead of pretending the
  // unanalyzed newest audit has zero findings.
  const latestAnalyzed = completed.find(a => a.has_analysis) || null
  const { summary: regionSummary, error: regionError } = useRegionSummary(latest?.id)

  // Open data-gap count — admin/analyst only, same access as Data Gaps page
  // itself. Silently stays null (no badge) on fetch failure/forbidden rather
  // than surfacing an error on the main dashboard for something this minor.
  const [openGapCount, setOpenGapCount] = useState<number | null>(null)
  useEffect(() => {
    if (user?.role !== 'admin' && user?.role !== 'analyst') return
    let cancelled = false
    api.listDataGaps().then(v => { if (!cancelled) setOpenGapCount(v.open.length) }).catch(() => {})
    return () => { cancelled = true }
  }, [user?.role])

  const [severityCounts, setSeverityCounts] = useState<SeverityCounts | null>(null)
  // recent 5 for the audits table, plus latestAnalyzed in case it's older
  // than the recent window.
  const countIds = Array.from(new Set([...recent.map(a => a.id), ...(latestAnalyzed ? [latestAnalyzed.id] : [])])).join(',')
  useEffect(() => {
    if (!countIds) return
    let cancelled = false
    api.severityCounts(countIds.split(',')).then(counts => { if (!cancelled) setSeverityCounts(counts) }).catch(() => {})
    return () => { cancelled = true }
  }, [countIds])

  const now = new Date()
  const auditsThisMonth = audits?.filter(a => {
    const d = new Date(a.created_at)
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
  }).length ?? 0

  const activeSubs = subs?.filter(s => s.is_active).length ?? null

  // Last 10 completed audits, oldest→newest, for the Total Resources
  // sparkline — hidden when the series is flat (a full-width slab of
  // identical values reads as a rendering bug, not a chart).
  const resourceSparkline = completed.slice(0, 10).reverse().map(totalResources)
  const sparklineVaries = new Set(resourceSparkline).size > 1

  // % change vs the previous completed audit — needs two audits of history.
  // A "↑ 0.0%" badge says nothing, so zero change shows no badge at all.
  const rawTrendPct = latest && previous && totalResources(previous) > 0
    ? ((totalResources(latest) - totalResources(previous)) / totalResources(previous)) * 100
    : null
  const trendPct = rawTrendPct !== null && Math.abs(rawTrendPct) >= 0.05 ? rawTrendPct : null

  // Per-severity history across the recent ANALYZED audits, oldest→newest,
  // for the mini bar charts — unanalyzed audits would show as fake zeros.
  const analyzedOldestFirst = [...recent].reverse().filter(a => a.has_analysis)
  const severitySeries = (key: 'critical' | 'warning' | 'info') =>
    severityCounts ? analyzedOldestFirst.map(a => severityCounts[a.id]?.[key] ?? 0) : []

  const latestSeverity = latestAnalyzed && severityCounts ? severityCounts[latestAnalyzed.id] : undefined
  const severityCaption = latestAnalyzed
    ? `last ${analyzedOldestFirst.length} analyzed audit${analyzedOldestFirst.length === 1 ? '' : 's'} · latest: ${shortId(latestAnalyzed.id)}`
    : undefined

  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = user?.email ? user.email.split('@')[0] : ''

  const cardTitleStyle: React.CSSProperties = { fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)' }

  return (
    <>
      <Header title="Dashboard" />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

        {/* Row 0 — compact greeting strip + search (replaces the old hero banner) */}
        <div className="animate-fade-in" style={{
          display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--t1)', letterSpacing: '-0.01em' }}>
              {greeting}{firstName ? `, ${firstName}` : ''}
            </p>
            <p style={{ fontSize: '0.76rem', color: 'var(--t3)', marginTop: '0.15rem' }}>
              {now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              {latest && ` · Latest audit ${shortId(latest.id)}`}
              {` · ${auditsThisMonth} audit${auditsThisMonth === 1 ? '' : 's'} this month`}
              {activeSubs !== null && ` · ${activeSubs} active subscription${activeSubs === 1 ? '' : 's'}`}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {!!openGapCount && (
              <Link
                href="/data-gaps"
                className="bdg bdg-warning"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', textDecoration: 'none' }}
              >
                <AlertTriangle size={12} />
                {openGapCount} open data gap{openGapCount === 1 ? '' : 's'}
              </Link>
            )}
            <DashboardSearch audits={audits || []} />
          </div>
        </div>

        {loading && (
          <>
            <KPISkeletonRow />
            <ChartSkeleton />
            <TableSkeleton rows={5} cols={4} />
          </>
        )}

        {!loading && error && (
          <div className="glass" style={{ padding: '2rem', textAlign: 'center' }}>
            <p style={{ color: '#ef4444', fontSize: '0.875rem', marginBottom: '1rem' }}>{error}</p>
            <button className="btn-ghost" onClick={load}>Retry</button>
          </div>
        )}

        {!loading && !error && (
          <>
            {latest ? (
              <>
                {/* Row 1 — three equal cards. No trend chart: total resource
                    count barely moves audit to audit, so the big line chart
                    was a flat stroke over a mostly-empty plot while forcing
                    the whole row tall (the "big empty space" complaint). */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
                  <div className="glass animate-fade-in" style={{ padding: '1.125rem', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                      <Boxes size={14} color="var(--acc)" />
                      <h3 style={cardTitleStyle}>Resource Types</h3>
                      <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--t4)', fontFamily: 'ui-monospace, monospace' }}>
                        audit {shortId(latest.id)}
                      </span>
                    </div>
                    <ResourceChart counts={latest.resource_counts || {}} compact />
                  </div>

                  <div className="glass animate-fade-in" style={{ padding: '1.125rem', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                      <ShieldAlert size={14} color="var(--acc)" />
                      <h3 style={cardTitleStyle}>Open Findings</h3>
                      {latestAnalyzed && (
                        <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--t4)', fontFamily: 'ui-monospace, monospace' }}>
                          audit {shortId(latestAnalyzed.id)}
                        </span>
                      )}
                    </div>
                    {latestAnalyzed ? (
                      <SeverityDonut counts={latestSeverity} />
                    ) : (
                      <p style={{ fontSize: '0.78rem', color: 'var(--t3)', padding: '1rem 0' }}>
                        No audit has been analyzed yet.
                      </p>
                    )}
                    {/* the newest audit lacking analysis is a task, not a dead
                        end — link straight to where Analyze lives */}
                    {latest && !latest.has_analysis && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap',
                        marginTop: 'auto', paddingTop: '0.75rem', borderTop: '1px solid var(--border)',
                      }}>
                        <p style={{ fontSize: '0.72rem', color: 'var(--t3)', flex: 1, minWidth: '10rem' }}>
                          Newest audit <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--acc)' }}>{shortId(latest.id)}</span> not analyzed yet
                        </p>
                        <Link href={`/audits/${latest.id}`} className="btn-primary" style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                          padding: '0.4rem 0.75rem', fontSize: '0.76rem', textDecoration: 'none',
                        }}>
                          <Play size={12} /> Run analysis
                        </Link>
                      </div>
                    )}
                  </div>

                  <div className="glass animate-fade-in" style={{ padding: '1.125rem', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                      <Database size={14} color="var(--acc)" />
                      <h3 style={cardTitleStyle}>Resource Changes</h3>
                    </div>
                    <p style={{ fontSize: '0.7rem', color: 'var(--t4)', marginBottom: '0.375rem' }}>
                      {previous ? `vs previous audit ${shortId(previous.id)}` : 'latest audit counts'}
                    </p>
                    <ResourceDeltaList latest={latest} previous={previous} />
                  </div>
                </div>

                {/* Row 2 — headline stat + per-severity mini cards */}
                <div className="stagger grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                  <KPICard
                    icon={Boxes}
                    label="Total Resources"
                    value={totalResources(latest)}
                    trend={trendPct !== null ? `${trendPct >= 0 ? '↑' : '↓'} ${Math.abs(trendPct).toFixed(1)}%` : undefined}
                    trendDir={trendPct !== null && trendPct < 0 ? 'down' : 'up'}
                    sub={rawTrendPct !== null && trendPct === null ? 'unchanged vs previous audit' : 'from latest audit'}
                    accent="cyan"
                    sparkline={sparklineVaries ? resourceSparkline : undefined}
                  />
                  <MiniSeverityCard label="Critical" color="#ef4444" count={latestSeverity?.critical ?? null} series={severitySeries('critical')} caption={severityCaption} />
                  <MiniSeverityCard label="Warning" color="#fbbf24" count={latestSeverity?.warning ?? null} series={severitySeries('warning')} caption={severityCaption} />
                  <MiniSeverityCard label="Info" color="#38bdf8" count={latestSeverity?.info ?? null} series={severitySeries('info')} caption={severityCaption} />
                </div>
              </>
            ) : (
              <div className="glass" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                <p style={{ color: 'var(--t2)', fontSize: '0.9rem', marginBottom: '0.375rem' }}>
                  No completed audits yet
                </p>
                <p style={{ color: 'var(--t3)', fontSize: '0.8rem' }}>
                  Audits will appear here once the first scheduled run finishes (daily at 1:30 PM Sri Lanka time).
                </p>
              </div>
            )}

            {/* Row 3 — three compact table cards */}
            <div className="cv-auto grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              <TopIssues limit={5} compact />
              <RecentAuditsCard audits={recent} severityCounts={severityCounts} />
              <RegionListCard summary={regionSummary} error={regionError} />
            </div>

            {/* Row 3.5 — $ saved tracking, its own row since it's org-wide
                rather than tied to the latest audit like the cards above */}
            <div className="cv-auto grid grid-cols-1 gap-4">
              <SavingsCard />
            </div>

            {/* Row 4 — cross-region detail, only when there are actual gaps
                (the all-clear state lives in the Regions card footer) */}
            {latest && regionSummary && regionSummary.mismatches.length > 0 && (
              <div className="cv-auto">
                <CrossRegionCheck summary={regionSummary} error={regionError} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
