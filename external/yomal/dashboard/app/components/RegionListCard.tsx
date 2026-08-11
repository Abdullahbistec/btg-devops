'use client'

import { MapPinned, TriangleAlert, Check } from 'lucide-react'
import { Skeleton } from './Skeleton'
import { categoricalColor } from '../lib/palette'
import type { RegionSummary } from '../types'

// Compact region list for the dashboard's bottom card row — replaces the
// full-width region donut on the home page (same data, table form reads
// faster in a dense grid). Footer surfaces the cross-region check result;
// the detailed mismatch panel only renders when there are actual gaps.
export function RegionListCard({ summary, error }: { summary: RegionSummary | null; error?: string }) {
  return (
    <div className="glass animate-fade-in" style={{ padding: '1.125rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <MapPinned size={14} color="var(--acc)" />
        <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)' }}>Regions</h3>
      </div>

      {error ? (
        <p style={{ fontSize: '0.78rem', color: 'var(--t3)', padding: '1rem 0' }}>Region data unavailable.</p>
      ) : !summary ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {[0, 1, 2, 3].map(i => <Skeleton key={i} height={18} />)}
        </div>
      ) : summary.distribution.length === 0 ? (
        <p style={{ fontSize: '0.78rem', color: 'var(--t3)', padding: '1rem 0' }}>No region data yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          {(() => {
            const total = summary.distribution.reduce((s, d) => s + d.count, 0)
            return summary.distribution.slice(0, 6).map((d, i) => (
              <div key={d.region} style={{
                display: 'flex', alignItems: 'center', gap: '0.55rem',
                padding: '0.5rem 0.25rem', borderBottom: '1px solid var(--border)',
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: categoricalColor(i), flexShrink: 0 }} />
                <span style={{ fontSize: '0.8rem', color: 'var(--t2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.region}
                </span>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--t1)', fontFamily: 'ui-monospace, monospace' }}>{d.count}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--t4)', width: 36, textAlign: 'right' }}>
                  {total > 0 ? Math.round((d.count / total) * 100) : 0}%
                </span>
              </div>
            ))
          })()}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingTop: '0.7rem', marginTop: 'auto' }}>
            {summary.mismatches.length > 0 ? (
              <>
                <TriangleAlert size={13} color="#fbbf24" />
                <span style={{ fontSize: '0.74rem', color: '#fbbf24' }}>
                  {summary.mismatches.length} cross-region gap{summary.mismatches.length === 1 ? '' : 's'} — details below
                </span>
              </>
            ) : (
              <>
                <Check size={13} color="#22c55e" />
                <span style={{ fontSize: '0.74rem', color: 'var(--t3)' }}>No cross-region gaps detected</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
