'use client'

import Link from 'next/link'
import { ArrowUpRight, ArrowDownRight, ArrowRight, Minus } from 'lucide-react'
import { ResourceIcon, resourceMeta } from '../lib/resourceMeta'
import type { Audit } from '../types'

// "What changed since the last audit" list — the RUNPIPE "Adoption of
// Products" zone. Computed entirely client-side from the resource_counts of
// the two most recent completed audits; with only one completed audit the
// deltas are hidden and it degrades to a plain count list.
export function ResourceDeltaList({ latest, previous }: { latest: Audit; previous: Audit | null }) {
  const latestCounts = latest.resource_counts || {}
  const prevCounts = previous?.resource_counts || {}

  const types = new Set([...Object.keys(latestCounts), ...Object.keys(prevCounts)])
  const rows = Array.from(types)
    .map(type => {
      const count = latestCounts[type] || 0
      const delta = previous ? count - (prevCounts[type] || 0) : 0
      return { type, count, delta }
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.count - a.count)
    .slice(0, 7)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        {rows.map(r => (
          <div key={r.type} style={{
            display: 'flex', alignItems: 'center', gap: '0.55rem',
            padding: '0.5rem 0', borderBottom: '1px solid var(--border)',
          }}>
            <ResourceIcon slug={r.type} size={14} />
            <span style={{
              fontSize: '0.8rem', color: 'var(--t2)', flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {resourceMeta(r.type).label}
            </span>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--t1)', fontFamily: 'ui-monospace, monospace' }}>
              {r.count}
            </span>
            {previous && (
              r.delta > 0 ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: '0.72rem', fontWeight: 700, color: '#22c55e', width: 40, justifyContent: 'flex-end' }}>
                  <ArrowUpRight size={12} /> {r.delta}
                </span>
              ) : r.delta < 0 ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: '0.72rem', fontWeight: 700, color: '#ef4444', width: 40, justifyContent: 'flex-end' }}>
                  <ArrowDownRight size={12} /> {Math.abs(r.delta)}
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: '0.72rem', color: 'var(--t4)', width: 40, justifyContent: 'flex-end' }}>
                  <Minus size={12} />
                </span>
              )
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <p style={{ fontSize: '0.78rem', color: 'var(--t3)', padding: '1rem 0' }}>No resources yet.</p>
        )}
      </div>
      <Link href={`/audits/${latest.id}`} style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.25rem', alignSelf: 'flex-end',
        fontSize: '0.76rem', color: 'var(--acc)', textDecoration: 'none', paddingTop: '0.625rem',
      }}>
        View details <ArrowRight size={12} />
      </Link>
    </div>
  )
}
