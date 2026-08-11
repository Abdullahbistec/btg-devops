'use client'

import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { TrendingUp } from 'lucide-react'
import { GlowDot } from './GlowDot'
import { RangeFilter, filterByRange, type RangeKey } from './RangeFilter'
import type { Audit } from '../types'

const TOTAL = '__total__'

function ChartTooltip({ active, payload, label, showTotal }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; showTotal: boolean }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(36, 31, 56, 0.88)', backdropFilter: 'blur(10px)',
      border: '1px solid var(--border-strong)', borderRadius: 12,
      padding: '0.6rem 0.8rem', boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
    }}>
      <p style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--t1)', marginBottom: 4 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ fontSize: '0.8rem', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
          {p.name}: <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{p.value ?? 0}</span>
        </p>
      ))}
    </div>
  )
}

export function TrendChart({ audits }: { audits: Audit[] }) {
  const [metric, setMetric] = useState<string>(TOTAL)
  const [range, setRange] = useState<RangeKey>('all')

  const completed = useMemo(
    () => audits
      .filter(a => a.status === 'completed')
      .sort((x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime()),
    [audits]
  )

  const resourceTypes = useMemo(() => {
    const set = new Set<string>()
    completed.forEach(a => Object.keys(a.resource_counts || {}).forEach(k => set.add(k)))
    return Array.from(set).sort()
  }, [completed])

  const ranged = useMemo(() => filterByRange(completed, range, a => a.created_at), [completed, range])

  const showTotal = metric !== TOTAL
  const data = useMemo(() => ranged.map(a => {
    const counts = a.resource_counts || {}
    const total = Object.values(counts).reduce((s, n) => s + n, 0)
    const value = metric === TOTAL ? total : counts[metric] || 0
    const d = new Date(a.created_at)
    return {
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      value,
      total,
    }
  }), [ranged, metric])

  const selectStyle: React.CSSProperties = {
    background: 'var(--panel)', border: '1px solid var(--border-strong)',
    borderRadius: 8, color: 'var(--t1)', padding: '0.3rem 0.55rem', fontSize: '0.8rem',
    cursor: 'pointer',
  }

  return (
    <div className="glass animate-fade-in" style={{ padding: '1.125rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem', flexWrap: 'wrap' }}>
        <TrendingUp size={14} color="var(--acc)" />
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)', flex: 1 }}>Trends Over Time</h2>
        <select style={selectStyle} value={metric} onChange={e => setMetric(e.target.value)}>
          <option value={TOTAL}>Total resources</option>
          {resourceTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <RangeFilter value={range} onChange={setRange} />
      </div>

      {completed.length < 2 ? (
        <div style={{ textAlign: 'center', padding: '2.25rem 1rem' }}>
          <p style={{ fontSize: '0.82rem', color: 'var(--t2)' }}>Not enough data yet</p>
          <p style={{ fontSize: '0.72rem', color: 'var(--t3)', marginTop: '0.25rem' }}>
            Trends appear once you have at least two completed audits.
          </p>
        </div>
      ) : (
        <div style={{ width: '100%', height: 190 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="trendStroke" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#8B5CF6" />
                  <stop offset="100%" stopColor="#38BDF8" />
                </linearGradient>
                <filter id="trendGlow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="0" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: 'var(--t3)' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip cursor={{ stroke: 'var(--border-strong)' }} content={<ChartTooltip showTotal={showTotal} />} />
              {showTotal && (
                <Line
                  type="monotone"
                  dataKey="total"
                  name="Total resources"
                  stroke="#38BDF8"
                  strokeOpacity={0.55}
                  strokeWidth={2}
                  strokeLinecap="round"
                  dot={false}
                  activeDot={false}
                  isAnimationActive
                  animationDuration={900}
                />
              )}
              <Line
                type="monotone"
                dataKey="value"
                name={metric === TOTAL ? 'Total resources' : metric}
                stroke="url(#trendStroke)"
                strokeWidth={2.5}
                strokeLinecap="round"
                dot={false}
                style={{ filter: 'url(#trendGlow)' }}
                activeDot={<GlowDot stroke="#8B5CF6" />}
                isAnimationActive
                animationDuration={1100}
                animationEasing="ease-out"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
