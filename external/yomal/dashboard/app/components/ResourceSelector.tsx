'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Boxes, ChevronRight, ChevronDown, ArrowRight } from 'lucide-react'
import type { ResourceListEntry } from '../types'
import { resourceMeta } from '../lib/resourceMeta'
import { formatCurrency } from './CostCharts'

const SIGNAL_META: Record<'zombie' | 'spike' | 'idle', { label: string; cls: string }> = {
  zombie: { label: 'Zombie spend', cls: 'bdg-error' },
  spike:  { label: 'Spend spike',  cls: 'bdg-warning' },
  idle:   { label: 'Idle',         cls: 'bdg-muted' },
}

interface ResourceSelectorProps {
  auditId: string
  resources: ResourceListEntry[]
  currency: string
}

/** One resource type row — expands to list its individual resources
 *  underneath. Clicking the type name goes to the Combined Overview page;
 *  clicking a nested resource goes straight to that resource's own page. */
function TypeRow({
  slug, count, resources, currency, onOpenType, onOpenResource,
}: {
  slug: string
  count: number
  resources: ResourceListEntry[]
  currency: string
  onOpenType: (slug: string) => void
  onOpenResource: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const label = slug === 'other' ? 'Other' : resourceMeta(slug).label

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        className="row-hover"
        style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.65rem 0.5rem' }}
      >
        <button
          onClick={() => setOpen(o => !o)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown size={14} color="var(--t3)" /> : <ChevronRight size={14} color="var(--t3)" />}
        </button>
        <button
          onClick={() => onOpenType(slug)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', flex: 1,
            display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--t1)', fontWeight: 500,
          }}
        >
          {label}
          <span className="bdg bdg-muted">{count}</span>
        </button>
        <button
          onClick={() => onOpenType(slug)}
          style={{
            background: 'none', border: '1px solid var(--border-strong)', borderRadius: 8,
            color: 'var(--t3)', fontSize: '0.72rem', padding: '0.25rem 0.6rem', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '0.3rem',
          }}
        >
          Overview <ArrowRight size={11} />
        </button>
      </div>

      {open && (
        <div style={{ padding: '0 0.5rem 0.6rem 2rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          {resources.map(r => (
            <button
              key={r.resource_id}
              onClick={() => onOpenResource(r.resource_id)}
              className="row-hover"
              style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
                background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                padding: '0.45rem 0.5rem', borderRadius: 6,
              }}
            >
              <span style={{ fontSize: '0.8rem', color: 'var(--t2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.resource_name}
              </span>
              {r.signals.map(s => (
                <span key={s} className={`bdg ${SIGNAL_META[s].cls}`}>{SIGNAL_META[s].label}</span>
              ))}
              <span style={{ fontSize: '0.78rem', color: 'var(--t3)', minWidth: 70, textAlign: 'right' }}>
                {formatCurrency(r.total_cost_usd, currency)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Step 1 of the resource drill-down: a type-grouped tree — one row per
 *  resource type, expandable to its individual resources underneath. */
export function ResourceSelector({ auditId, resources, currency }: ResourceSelectorProps) {
  const router = useRouter()

  const grouped = useMemo(() => {
    const byType = new Map<string, ResourceListEntry[]>()
    for (const r of resources) {
      const key = r.resource_type || 'other'
      const list = byType.get(key) || []
      list.push(r)
      byType.set(key, list)
    }
    return Array.from(byType.entries())
      .map(([slug, list]) => ({ slug, count: list.length, resources: list.sort((a, b) => b.total_cost_usd - a.total_cost_usd) }))
      .sort((a, b) => b.count - a.count)
  }, [resources])

  if (grouped.length === 0) return null

  function openType(slug: string) {
    router.push(`/cost-usage/type?auditId=${encodeURIComponent(auditId)}&type=${encodeURIComponent(slug)}`)
  }
  function openResource(resourceId: string) {
    router.push(`/cost-usage/resource?auditId=${encodeURIComponent(auditId)}&resourceId=${encodeURIComponent(resourceId)}`)
  }

  return (
    <div className="glass" style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <Boxes size={15} color="var(--acc)" />
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>Browse by Resource Type</h2>
      </div>
      <div>
        {grouped.map(g => (
          <TypeRow
            key={g.slug}
            slug={g.slug}
            count={g.count}
            resources={g.resources}
            currency={currency}
            onOpenType={openType}
            onOpenResource={openResource}
          />
        ))}
      </div>
    </div>
  )
}
