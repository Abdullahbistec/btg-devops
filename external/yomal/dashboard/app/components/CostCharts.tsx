'use client'

import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { DollarSign, ListOrdered } from 'lucide-react'
import { categoricalColor } from '../lib/palette'
import { GlowDot } from './GlowDot'
import { RangeFilter, filterByRange, type RangeKey } from './RangeFilter'

function formatCurrency(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getDate()}`
}

function CostTooltip({ active, payload, label, currency }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; currency: string }) {
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
          {p.name}: <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{formatCurrency(p.value || 0, currency)}</span>
        </p>
      ))}
    </div>
  )
}

export function CostTrendChart({ dailyCost, currency }: { dailyCost: { date: string; cost: number }[]; currency: string }) {
  const [range, setRange] = useState<RangeKey>('all')
  const ranged = useMemo(() => filterByRange(dailyCost, range, d => d.date), [dailyCost, range])

  const data = useMemo(() => ranged.map((d, i, arr) => {
    const windowStart = Math.max(0, i - 6)
    const window = arr.slice(windowStart, i + 1)
    const avg = window.reduce((s, x) => s + x.cost, 0) / window.length
    return { date: shortDate(d.date), cost: d.cost, avg }
  }), [ranged])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem', flexWrap: 'wrap' }}>
        <DollarSign size={15} color="var(--acc)" />
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)', flex: 1 }}>Daily Cost Trend</h2>
        <RangeFilter value={range} onChange={setRange} />
      </div>
      {data.length === 0 ? (
        <p style={{ fontSize: '0.82rem', color: 'var(--t3)', padding: '1rem 0' }}>No daily cost data available.</p>
      ) : (
      <div style={{ width: '100%', height: 190 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="costStroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#8B5CF6" />
                <stop offset="100%" stopColor="#38BDF8" />
              </linearGradient>
              <filter id="costGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="0" />
            <XAxis dataKey="date" tick={{ fontSize: 12, fill: 'var(--t3)' }} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ stroke: 'var(--border-strong)' }} content={<CostTooltip currency={currency} />} />
            {data.length > 6 && (
              <Line
                type="monotone"
                dataKey="avg"
                name="7-audit avg"
                stroke="#38BDF8"
                strokeOpacity={0.5}
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
              dataKey="cost"
              name="Cost"
              stroke="url(#costStroke)"
              strokeWidth={2.5}
              strokeLinecap="round"
              dot={false}
              style={{ filter: 'url(#costGlow)' }}
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

function ServiceTooltip({ active, payload, label, currency }: { active?: boolean; payload?: { value: number }[]; label?: string; currency: string }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(36, 31, 56, 0.88)', backdropFilter: 'blur(10px)',
      border: '1px solid var(--border-strong)', borderRadius: 12,
      padding: '0.5rem 0.75rem', boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
    }}>
      <p style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--t1)', marginBottom: 2 }}>{label}</p>
      <p style={{ fontSize: '0.8rem', color: 'var(--t2)' }}>
        Cost: <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{formatCurrency(payload[0].value || 0, currency)}</span>
      </p>
    </div>
  )
}

function ServiceDot(props: { cx?: number; cy?: number; index?: number }) {
  const { cx, cy, index = 0 } = props
  if (cx == null || cy == null) return null
  return <circle cx={cx} cy={cy} r={4} fill={categoricalColor(index)} stroke="var(--card)" strokeWidth={2} />
}

export function TopServicesChart({ topServices, currency }: { topServices: { service: string; cost: number }[]; currency: string }) {
  const data = topServices.map(s => ({
    ...s,
    label: s.service.length > 10 ? `${s.service.slice(0, 9)}…` : s.service,
  }))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
        <ListOrdered size={15} color="var(--acc)" />
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>Top Services by Spend</h2>
      </div>
      {data.length === 0 ? (
        <p style={{ fontSize: '0.82rem', color: 'var(--t3)', padding: '1rem 0' }}>No service cost data available.</p>
      ) : (
        <div style={{ width: '100%', height: 190 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="serviceStroke" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#8B5CF6" />
                  <stop offset="100%" stopColor="#38BDF8" />
                </linearGradient>
                <filter id="serviceGlow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="0" />
              <XAxis dataKey="label" interval={0} tick={{ fontSize: 11, fill: 'var(--t3)' }} axisLine={false} tickLine={false} angle={-25} textAnchor="end" height={34} />
              <Tooltip cursor={{ stroke: 'var(--border-strong)' }} content={<ServiceTooltip currency={currency} />} />
              <Line
                type="monotone"
                dataKey="cost"
                stroke="url(#serviceStroke)"
                strokeWidth={2.5}
                strokeLinecap="round"
                style={{ filter: 'url(#serviceGlow)' }}
                dot={<ServiceDot />}
                activeDot={<GlowDot stroke="#8B5CF6" />}
                isAnimationActive
                animationDuration={1000}
                animationEasing="ease-out"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

export { formatCurrency }
