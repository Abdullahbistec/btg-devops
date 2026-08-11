'use client'

import { useEffect, useState } from 'react'
import { PiggyBank } from 'lucide-react'
import { Skeleton } from './Skeleton'
import { api } from '../lib/api'

// Small "$ saved" card — sums cost_impact_usd for findings that auto-
// resolved (saveFindings' lifecycle logic marks a cost-waste finding
// resolved once it stops appearing in a fresh analysis). Every number here
// comes straight from a SQL aggregation (models/findings.ts's
// findMonthlySavings), not an LLM estimate.
export function SavingsCard() {
  const [data, setData] = useState<{
    months: { month: string; total_saved_usd: number; findings_resolved: number }[]
    total_saved_usd: number
    total_findings_resolved: number
  } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.savings()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load savings'))
  }, [])

  const thisMonth = data?.months[0]

  return (
    <div className="glass animate-fade-in" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.875rem' }}>
        <PiggyBank size={15} color="var(--acc)" style={{ alignSelf: 'center' }} />
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>$ Saved</h2>
        <span style={{ fontSize: '0.72rem', color: 'var(--t4)' }}>from resolved cost-waste findings, last 12 months</span>
      </div>

      {error && <p style={{ fontSize: '0.8rem', color: '#ef4444' }}>{error}</p>}

      {!data && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Skeleton height={32} />
          <Skeleton height={16} />
        </div>
      )}

      {data && (
        <div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--t1)', lineHeight: 1.1 }}>
            ${data.total_saved_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--t3)', marginTop: '0.25rem' }}>
            {data.total_findings_resolved} cost-waste finding{data.total_findings_resolved === 1 ? '' : 's'} resolved
            {thisMonth ? ` · $${thisMonth.total_saved_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })} this month` : ''}
          </p>
          {data.months.length === 0 && (
            <p style={{ fontSize: '0.8rem', color: 'var(--t3)', padding: '0.5rem 0' }}>
              No resolved cost-waste findings yet — this fills in as issues get fixed between audits.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
