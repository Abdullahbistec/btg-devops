'use client'

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { Skeleton } from './Skeleton'

// Same three severity hexes used everywhere else (TopIssues, page severity
// dots) — not the categorical palette, since severity has fixed semantics.
const SEGMENTS = [
  { key: 'critical' as const, label: 'Critical', color: '#ef4444' },
  { key: 'warning' as const, label: 'Warning', color: '#fbbf24' },
  { key: 'info' as const, label: 'Info', color: '#38bdf8' },
]

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

// Compact donut of open findings by severity for the latest audit —
// undefined counts = still loading, all-zero = nothing open.
export function SeverityDonut({ counts }: { counts?: { critical: number; warning: number; info: number } }) {
  if (!counts) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flex: 1 }}>
        <Skeleton width={160} height={160} radius={80} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {[0, 1, 2].map(i => <Skeleton key={i} height={18} />)}
        </div>
      </div>
    )
  }

  const data = SEGMENTS.map(s => ({ name: s.label, value: counts[s.key], fill: s.color }))
  const total = counts.critical + counts.warning + counts.info

  if (total === 0) {
    return (
      <p style={{ fontSize: '0.78rem', color: 'var(--t3)', padding: '1rem 0' }}>
        No open findings on the latest audit.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flex: 1 }}>
      <div style={{ width: 160, height: 160, flexShrink: 0, position: 'relative' }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data.filter(d => d.value > 0)}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive
              animationDuration={800}
            >
              {data.filter(d => d.value > 0).map(d => <Cell key={d.name} fill={d.fill} />)}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
        }}>
          <span style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--t1)' }}>{total}</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>open</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', flex: 1, minWidth: 0 }}>
        {SEGMENTS.map(s => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.84rem' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--t2)', flex: 1 }}>{s.label}</span>
            <span style={{ color: 'var(--t1)', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{counts[s.key]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
