'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { History, ArrowRight } from 'lucide-react'
import { Badge } from './Badge'
import { shortId, statusConfig } from '../lib/utils'
import type { Audit } from '../types'

export type SeverityCounts = Record<string, { critical: number; warning: number; info: number }>

function SeverityDot({ color, count }: { color: string; count: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: '0.72rem', fontFamily: 'ui-monospace, monospace', fontWeight: 700, color }}>{count}</span>
    </span>
  )
}

// Per-row glance-able severity signal — "Cached" only told you analysis
// ran, not whether it found anything worth attention.
export function SeverityCell({ audit, counts }: { audit: Audit; counts: SeverityCounts | null }) {
  if (!audit.has_analysis) return <span style={{ color: 'var(--t4)', fontSize: '0.78rem' }}>—</span>
  const c = counts?.[audit.id]
  if (!c) return <span style={{ color: 'var(--t4)', fontSize: '0.78rem' }}>…</span>
  if (c.critical === 0 && c.warning === 0 && c.info === 0) {
    return <span style={{ color: '#22c55e', fontSize: '0.78rem' }}>✓ clean</span>
  }
  return (
    <span style={{ display: 'inline-flex', gap: '0.6rem', alignItems: 'center' }}>
      {c.critical > 0 && <SeverityDot color="#ef4444" count={c.critical} />}
      {c.warning > 0 && <SeverityDot color="#fbbf24" count={c.warning} />}
      {c.critical === 0 && c.warning === 0 && c.info > 0 && <SeverityDot color="#38bdf8" count={c.info} />}
    </span>
  )
}

// Slim 4-column recent-audits card for the dashboard's bottom card row —
// the full 8-column table lives on /audits.
export function RecentAuditsCard({ audits, severityCounts }: {
  audits: Audit[]
  severityCounts: SeverityCounts | null
}) {
  const router = useRouter()

  return (
    <div className="glass animate-fade-in" style={{ padding: '1.125rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <History size={14} color="var(--acc)" />
        <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)' }}>Recent Audits</h3>
      </div>

      {audits.length === 0 ? (
        <p style={{ color: 'var(--t3)', fontSize: '0.78rem', padding: '1rem 0' }}>No audits yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          {audits.map(a => {
            const sc = statusConfig[a.status] || { label: a.status, color: 'muted' }
            return (
              <div
                key={a.id}
                className="row-hover"
                onClick={() => router.push(`/audits/${a.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.6rem',
                  padding: '0.55rem 0.25rem', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                }}
              >
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', color: 'var(--acc)' }}>
                  {shortId(a.id)}
                </span>
                <span style={{ fontSize: '0.74rem', color: 'var(--t3)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {new Date(a.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  {' · '}
                  {new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <Badge color={sc.color} label={sc.label} />
                <SeverityCell audit={a} counts={severityCounts} />
              </div>
            )
          })}
          <Link href="/audits" style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.25rem', alignSelf: 'flex-end',
            fontSize: '0.76rem', color: 'var(--acc)', textDecoration: 'none', paddingTop: '0.625rem', marginTop: 'auto',
          }}>
            View all <ArrowRight size={12} />
          </Link>
        </div>
      )}
    </div>
  )
}
