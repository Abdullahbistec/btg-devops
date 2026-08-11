'use client'

import { BarChart, Bar, ResponsiveContainer } from 'recharts'

// Small stat card with a mini bar history — the RUNPIPE "Forecast Qx"
// zone, one card per severity. `series` is that severity's open count
// across the recent audits, oldest→newest; a single-point series hides the
// mini chart rather than drawing one lonely bar.
export function MiniSeverityCard({ label, color, count, series, caption }: {
  label: string
  color: string
  count: number | null
  series: number[]
  // e.g. "last 5 analyzed audits" — says which audits the bars cover, so a
  // count from an older analyzed audit is never mistaken for the newest run.
  caption?: string
}) {
  const barData = series.length > 1 ? series.map((v, i) => ({ i, v })) : null

  return (
    <div className="glass-hover" style={{
      padding: '1rem 1.125rem', borderRadius: 'var(--radius)',
      border: '1px solid var(--border)', background: 'var(--card)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{
          fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--t3)',
        }}>
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.75rem' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--t1)', fontFamily: 'ui-monospace, monospace', lineHeight: 1.1 }}>
            {count ?? '—'}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--t3)', marginTop: '0.2rem' }}>open findings</div>
        </div>
        {barData && (
          <div style={{ width: 84, height: 34, flexShrink: 0 }}>
            <ResponsiveContainer>
              <BarChart data={barData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }} barCategoryGap="25%">
                <Bar dataKey="v" fill={color} fillOpacity={0.75} radius={[2, 2, 0, 0]} isAnimationActive={false} minPointSize={2} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {caption && (
        <div style={{ fontSize: '0.64rem', color: 'var(--t4)', marginTop: '0.3rem' }}>{caption}</div>
      )}
    </div>
  )
}
