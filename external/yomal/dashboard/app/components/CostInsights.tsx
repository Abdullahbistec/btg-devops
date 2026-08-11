'use client'

import { useState } from 'react'
import { Ghost, Zap, Boxes } from 'lucide-react'
import type {
  ZombieSpendFinding, SpendSpikeFinding,
  ResourceGroupCostRollup, TagCostRollup,
} from '../types'
import { formatCurrency } from './CostCharts'

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '0.3rem 0.5rem',
  fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: 'var(--t4)',
}
const tdStyle: React.CSSProperties = { padding: '0.4rem 0.5rem', color: 'var(--t2)' }

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '0.82rem', color: 'var(--t3)', padding: '0.5rem 0' }}>{children}</p>
}

function SectionHeading({ icon: Icon, title, count }: { icon: React.ComponentType<{ size?: number; color?: string }>; title: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
      <Icon size={15} color="var(--acc)" />
      <h3 style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--t1)', flex: 1 }}>{title}</h3>
      {count > 0 && <span className="bdg bdg-muted">{count}</span>}
    </div>
  )
}

export function ZombieSpendList({ findings, currency }: { findings: ZombieSpendFinding[]; currency: string }) {
  return (
    <div>
      <SectionHeading icon={Ghost} title="Zombie Spend" count={findings.length} />
      {findings.length === 0 ? (
        <EmptyState>No spend found on resources that no longer exist in this audit&apos;s inventory.</EmptyState>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr>
              {['Resource', 'Last Service', 'Total Cost', 'Billed Days'].map(h => <th key={h} style={thStyle}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {findings.map(f => (
              <tr key={f.resource_id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...tdStyle, color: 'var(--t1)' }} title={f.resource_id}>{f.resource_name}</td>
                <td style={tdStyle}>{f.last_service_name || '—'}</td>
                <td style={tdStyle}>{formatCurrency(f.total_cost_usd, currency)}</td>
                <td style={tdStyle}>{f.billed_days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function SpendSpikesList({ findings, currency }: { findings: SpendSpikeFinding[]; currency: string }) {
  return (
    <div>
      <SectionHeading icon={Zap} title="Spend Spikes" count={findings.length} />
      {findings.length === 0 ? (
        <EmptyState>No statistically abnormal cost days detected.</EmptyState>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr>
              {['Resource', 'Date', 'Amount', 'Baseline Avg', 'Signal'].map(h => <th key={h} style={thStyle}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr key={`${f.resource_id}-${f.spike_date}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...tdStyle, color: 'var(--t1)' }} title={f.resource_id}>{f.resource_name}</td>
                <td style={tdStyle}>{f.spike_date}</td>
                <td style={tdStyle}>{formatCurrency(f.spike_amount_usd, currency)}</td>
                <td style={tdStyle}>{formatCurrency(f.baseline_daily_avg_usd, currency)}</td>
                <td style={tdStyle}>
                  {f.flat_baseline ? (
                    <span className="bdg bdg-muted">flat baseline</span>
                  ) : (
                    <span className="bdg bdg-error">z={f.z_score}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function CostBreakdownTabs({
  byResourceGroup, byTag, currency,
}: { byResourceGroup: ResourceGroupCostRollup[]; byTag: TagCostRollup[]; currency: string }) {
  const [tab, setTab] = useState<'group' | 'tag'>('group')
  const rows = tab === 'group' ? byResourceGroup : byTag

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
        <Boxes size={15} color="var(--acc)" />
        <h3 style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--t1)', flex: 1 }}>Cost Breakdown</h3>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {(['group', 'tag'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={tab === t ? 'bdg bdg-success' : 'bdg bdg-muted'}
              style={{ border: 'none', cursor: 'pointer' }}
            >
              {t === 'group' ? 'By Resource Group' : 'By Tag'}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState>
          {tab === 'group' ? 'No resource-group cost data available (inventory may be truncated).' : 'No tagged resources with cost data found.'}
        </EmptyState>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr>
              <th style={thStyle}>{tab === 'group' ? 'Resource Group' : 'Tag'}</th>
              <th style={thStyle}>Total Cost</th>
              <th style={thStyle}>Resources</th>
            </tr>
          </thead>
          <tbody>
            {tab === 'group'
              ? byResourceGroup.map(r => (
                <tr key={r.resource_group} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...tdStyle, color: 'var(--t1)' }}>{r.resource_group}</td>
                  <td style={tdStyle}>{formatCurrency(r.total_cost_usd, currency)}</td>
                  <td style={tdStyle}>{r.resource_count}</td>
                </tr>
              ))
              : byTag.map(t => (
                <tr key={`${t.tag_key}::${t.tag_value}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...tdStyle, color: 'var(--t1)' }}>{t.tag_key}: {t.tag_value}</td>
                  <td style={tdStyle}>{formatCurrency(t.total_cost_usd, currency)}</td>
                  <td style={tdStyle}>{t.resource_count}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
