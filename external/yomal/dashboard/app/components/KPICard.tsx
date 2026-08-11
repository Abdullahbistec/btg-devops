'use client'

import { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AreaChart, Area, ResponsiveContainer } from 'recharts'
import { useCountUp } from '../lib/useCountUp'
import { formatNumber } from '../lib/utils'

// Validated (dataviz skill, node scripts/validate_palette.js) against our
// actual card surface #141a25 — all 6 pass lightness/chroma/CVD/contrast.
const accents: Record<string, { solid: string; soft: string; wash: string }> = {
  cyan:    { solid: '#3987e5', soft: 'rgba(57, 135, 229, 0.16)',  wash: 'rgba(57, 135, 229, 0.10)' },
  emerald: { solid: '#199e70', soft: 'rgba(25, 158, 112, 0.16)',  wash: 'rgba(25, 158, 112, 0.10)' },
  violet:  { solid: '#9085e9', soft: 'rgba(144, 133, 233, 0.16)', wash: 'rgba(144, 133, 233, 0.10)' },
  amber:   { solid: '#c98500', soft: 'rgba(201, 133, 0, 0.16)',   wash: 'rgba(201, 133, 0, 0.10)' },
}

interface KPICardProps {
  label: string
  value: number | string | ReactNode
  icon?: LucideIcon
  trend?: string
  trendDir?: 'up' | 'down'
  sub?: ReactNode
  accent?: 'cyan' | 'emerald' | 'violet' | 'amber'
  /** Optional recent-history series for the mini chart under the value. */
  sparkline?: number[]
}

function CountUpValue({ target }: { target: number }) {
  const value = useCountUp(target)
  return <>{formatNumber(value)}</>
}

export function KPICard({ label, value, icon: Icon, trend, trendDir, sub, accent, sparkline }: KPICardProps) {
  const a = accent ? accents[accent] : accents.cyan
  const sparkData = sparkline && sparkline.length > 1 ? sparkline.map((v, i) => ({ i, v })) : null

  return (
    <div
      className="glass-hover"
      style={{
        position: 'relative', overflow: 'hidden', padding: '1.125rem 1.25rem',
        borderRadius: 'var(--radius)', border: '1px solid var(--border)',
        background: `linear-gradient(155deg, ${a.wash} 0%, var(--card) 60%)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <div style={{
          fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--t3)',
        }}>
          {label}
        </div>
        {Icon && (
          <div style={{
            width: 32, height: 32, borderRadius: 9, background: a.soft,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Icon size={16} color={a.solid} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        <div style={{
          fontSize: '1.6rem', fontWeight: 700, color: 'var(--t1)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>
          {typeof value === 'number' ? <CountUpValue target={value} /> : value}
        </div>
        {trend && (
          <span className={`bdg ${trendDir === 'down' ? 'bdg-error' : 'bdg-success'}`}>
            {trend}
          </span>
        )}
      </div>
      {sub && (
        <div style={{ fontSize: '0.72rem', color: 'var(--t3)', marginTop: '0.375rem' }}>
          {sub}
        </div>
      )}
      {sparkData && (
        <div style={{ height: 34, margin: '0.625rem -0.25rem -0.25rem' }}>
          <ResponsiveContainer>
            <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`spark-${accent}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={a.solid} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={a.solid} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke={a.solid} strokeWidth={1.5} fill={`url(#spark-${accent})`} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
