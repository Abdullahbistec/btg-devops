'use client'

import { useEffect, useState } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from 'recharts'
import { Globe, TriangleAlert } from 'lucide-react'
import { api } from '../lib/api'
import { resourceMeta } from '../lib/resourceMeta'
import { categoricalColor } from '../lib/palette'
import { Skeleton } from './Skeleton'
import type { RegionSummary } from '../types'

function DonutTooltip({ active, payload }: { active?: boolean; payload?: { name: string; value: number; payload: { fill: string } }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <div style={{
      background: 'rgba(36, 31, 56, 0.88)', backdropFilter: 'blur(10px)',
      border: '1px solid var(--border-strong)', borderRadius: 12,
      padding: '0.5rem 0.75rem', boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
    }}>
      <p style={{ fontSize: '0.82rem', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.payload.fill, display: 'inline-block' }} />
        {p.name}: <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{p.value}</span>
      </p>
    </div>
  )
}

/** Fetches the region summary for an audit; shared by the two panels below. */
export function useRegionSummary(auditId: string | null | undefined) {
  const [summary, setSummary] = useState<RegionSummary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!auditId) return
    let cancelled = false
    setSummary(null)
    setError('')
    api.getRegionSummary(auditId)
      .then(s => { if (!cancelled) setSummary(s) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load region data') })
    return () => { cancelled = true }
  }, [auditId])

  return { summary, error }
}

export function RegionDistributionChart({ summary, error }: { summary: RegionSummary | null; error?: string }) {
  if (error) return null
  if (!summary) {
    return (
      <div>
        <Skeleton width={160} height={16} style={{ marginBottom: '1rem' }} />
        <Skeleton height={190} radius={8} />
      </div>
    )
  }
  if (summary.distribution.length === 0) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', height: 190 }}>
      <div style={{ width: 150, height: 150, flexShrink: 0, position: 'relative' }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={summary.distribution}
              dataKey="count"
              nameKey="region"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive
              animationDuration={800}
            >
              {summary.distribution.map((entry, i) => (
                <Cell key={entry.region} fill={categoricalColor(i)} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
        }}>
          <span style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--t1)' }}>
            {summary.distribution.reduce((s, d) => s + d.count, 0)}
          </span>
          <span style={{ fontSize: '0.74rem', color: 'var(--t3)' }}>resources</span>
        </div>
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', overflowY: 'auto', height: '100%', flex: 1 }}>
        {summary.distribution.map((d, i) => (
          <div key={d.region} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.84rem' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: categoricalColor(i), flexShrink: 0 }} />
            <span style={{ color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{d.region}</span>
            <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{d.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CrossRegionCheck({ summary, error }: { summary: RegionSummary | null; error?: string }) {
  if (error) return null
  if (!summary) {
    return (
      <div className="glass animate-fade-in" style={{ padding: '1.125rem' }}>
        <Skeleton width={160} height={16} style={{ marginBottom: '1rem' }} />
        <Skeleton height={140} radius={8} />
      </div>
    )
  }
  if (summary.distribution.length === 0) return null

  return (
    <div className="glass animate-fade-in" style={{ padding: '1.125rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
        <TriangleAlert size={14} color={summary.mismatches.length > 0 ? '#fbbf24' : 'var(--acc)'} />
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)' }}>Cross-Region Check</h2>
      </div>
      <p style={{ fontSize: '0.76rem', color: 'var(--t3)', marginBottom: '0.625rem' }}>
        Regions with compute resources but no local database/storage — a hint worth checking, not a confirmed problem.
      </p>

      {summary.mismatches.length === 0 ? (
        <div style={{ padding: '1.5rem 1rem', textAlign: 'center' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--t2)' }}>No cross-region gaps detected.</p>
          <p style={{ fontSize: '0.78rem', color: 'var(--t3)', marginTop: '0.25rem' }}>
            Every region with compute resources also has a database/storage resource in the same region.
          </p>
        </div>
      ) : (
        <div className="no-scrollbar" style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', maxHeight: 260, overflowY: 'auto' }}>
          {summary.mismatches.map(m => (
            <div key={m.region} style={{
              border: '1px solid rgba(251,191,36,0.25)', background: 'rgba(251,191,36,0.06)',
              borderRadius: 8, padding: '0.7rem 0.85rem',
            }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)', marginBottom: '0.375rem' }}>
                {m.region} <span style={{ fontWeight: 400, color: 'var(--t3)' }}>— no local data resource</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                {m.computeResources.map((c, i) => (
                  <span key={i} style={{
                    fontSize: '0.76rem', color: 'var(--t2)', fontFamily: 'ui-monospace, monospace',
                    background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.15rem 0.45rem',
                  }}>
                    {resourceMeta(c.type).label}: {c.name}
                  </span>
                ))}
              </div>
              <p style={{ fontSize: '0.76rem', color: 'var(--t3)', marginTop: '0.4rem' }}>
                Data resources exist in: {m.dataRegions.join(', ')}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export { Globe }
