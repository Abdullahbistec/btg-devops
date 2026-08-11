'use client'

import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { formatNumber } from '../lib/utils'

interface MetricSummary {
  metric_name: string
  unit: string
  avg: number | null
  total: number | null
}

interface ResourceGroup {
  resource_id: string
  metrics: MetricSummary[]
}

function shortResourceName(resourceId: string): string {
  const parts = resourceId.split('/')
  return parts[parts.length - 1] || resourceId
}

function ResourceRow({ group }: { group: ResourceGroup }) {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="row-hover"
        style={{
          display: 'flex', alignItems: 'center', gap: '0.625rem', width: '100%',
          padding: '0.6rem 0.5rem', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={14} color="var(--t3)" /> : <ChevronRight size={14} color="var(--t3)" />}
        <span style={{
          fontSize: '0.82rem', color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', maxWidth: 320,
        }}>
          {shortResourceName(group.resource_id)}
        </span>
        <span className="bdg bdg-muted" style={{ marginLeft: 'auto' }}>
          {group.metrics.length} metric{group.metrics.length === 1 ? '' : 's'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 0.5rem 0.75rem 2rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
            <thead>
              <tr>
                {['Metric', 'Unit', 'Avg', 'Total'].map(h => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '0.3rem 0.5rem',
                    fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.05em',
                    textTransform: 'uppercase', color: 'var(--t4)',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.metrics.map((m, i) => (
                <tr key={i}>
                  <td style={{ padding: '0.3rem 0.5rem', color: 'var(--t2)', fontFamily: 'ui-monospace, monospace' }}>{m.metric_name}</td>
                  <td style={{ padding: '0.3rem 0.5rem', color: 'var(--t3)' }}>{m.unit}</td>
                  <td style={{ padding: '0.3rem 0.5rem', color: 'var(--t2)' }}>{m.avg !== null ? formatNumber(Math.round(m.avg * 100) / 100) : '—'}</td>
                  <td style={{ padding: '0.3rem 0.5rem', color: 'var(--t2)' }}>{m.total !== null ? formatNumber(Math.round(m.total)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Expects pre-aggregated, pre-sorted (highest activity first) groups from the server. */
export function UsageTable({ groups }: { groups: ResourceGroup[] }) {
  if (groups.length === 0) {
    return <p style={{ fontSize: '0.82rem', color: 'var(--t3)', padding: '1rem 0' }}>No usage metrics available.</p>
  }

  return (
    <div>
      <p style={{ fontSize: '0.72rem', color: 'var(--t4)', marginBottom: '0.5rem' }}>
        Sorted by highest activity · {groups.length} resource{groups.length === 1 ? '' : 's'} sampled
      </p>
      {groups.map(g => <ResourceRow key={g.resource_id} group={g} />)}
    </div>
  )
}
