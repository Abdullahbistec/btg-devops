'use client'

import { useState } from 'react'
import { AlertCircle, AlertTriangle, Info, EyeOff, RotateCcw } from 'lucide-react'
import { Badge } from './Badge'
import { CostBadge } from './CostBadge'
import { FixSteps } from './FixSteps'
import { EvidenceBlock } from './EvidenceBlock'
import { SEVERITY_ORDER, type DisplayFinding } from '../lib/findingsLayout'
import { severityConfig, findingStatusConfig, findingAge } from '../lib/utils'

const severityIcons = {
  Critical: <AlertCircle size={15} color="#ef4444" />,
  Warning:  <AlertTriangle size={15} color="#fbbf24" />,
  Info:     <Info size={15} color="#38bdf8" />,
}

// Every finding is already one issue-pattern card by the time it reaches
// here — the analysis prompt asks the model to emit one finding per issue
// with an `affected_resources` list, rather than one row per resource, so
// no further client-side clustering on issue text happens (that would be
// unreliable — see findingKey's comment in claude.ts).
function affectedTags(f: DisplayFinding): string[] {
  if (f.affected_resources && f.affected_resources.length > 0) return f.affected_resources
  return f.resource_name ? [f.resource_name] : []
}

function ResourceTags({ names }: { names: string[] }) {
  if (names.length === 0) return null
  const visible = names.slice(0, 3)
  const extra = names.length - visible.length
  return (
    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
      {visible.map(n => (
        <span key={n} className="bdg bdg-muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.68rem' }}>
          {n}
        </span>
      ))}
      {extra > 0 && (
        <span className="bdg bdg-muted" style={{ fontSize: '0.68rem' }}>+{extra} more</span>
      )}
    </div>
  )
}

// Exported so FindingsGroupAccount can render shared/cross-account findings
// with the same issue-first card style (a shared finding is never titled
// with one account's name — see the "Shared issue" section there).
export function IssueCard({ f, canAnalyze, onToggleStatus }: {
  f: DisplayFinding
  canAnalyze: boolean
  onToggleStatus: (id: string, status: 'open' | 'dismissed') => void
}) {
  const sc = severityConfig[f.severity] || { label: f.severity, color: 'muted' }
  const age = f.first_seen_at ? findingAge(f.first_seen_at) : null
  const st = f.status && f.status !== 'open' ? findingStatusConfig[f.status] : null
  const isCritical = f.severity === 'Critical'

  return (
    <div style={{
      border: `1px solid ${isCritical ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
      borderRadius: 8, padding: '0.875rem 1rem',
      background: isCritical ? 'rgba(239,68,68,0.06)' : 'var(--input-bg)',
      opacity: f.status === 'dismissed' ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.5rem' }}>
        {severityIcons[f.severity]}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.35rem' }}>
            <Badge color={sc.color} label={sc.label} />
            {f.category && <Badge color="muted" label={f.category} />}
            {age && <Badge color={age.color} label={age.label} />}
            {st && <Badge color={st.color} label={st.label} />}
            {canAnalyze && f.id && f.status !== 'resolved' && (
              <button
                onClick={() => onToggleStatus(f.id!, f.status === 'dismissed' ? 'open' : 'dismissed')}
                title={f.status === 'dismissed' ? 'Reopen this finding' : "Dismiss (won't fix / accepted risk)"}
                style={{
                  background: 'none', border: '1px solid var(--border-strong)', borderRadius: 6,
                  color: 'var(--t3)', padding: '0.2rem 0.35rem', cursor: 'pointer', display: 'flex',
                }}
              >
                {f.status === 'dismissed' ? <RotateCcw size={12} /> : <EyeOff size={12} />}
              </button>
            )}
          </div>
          <ResourceTags names={affectedTags(f)} />
        </div>
        <CostBadge usd={f.cost_impact_usd} note={f.cost_impact_note} />
      </div>
      <p style={{ fontSize: '0.82rem', color: 'var(--t1)', lineHeight: 1.55 }}>{f.issue}</p>
      <EvidenceBlock evidence={f.evidence} />
      <FixSteps steps={f.recommendation_steps} fallback={f.recommendation} />
    </div>
  )
}

function InfoRow({ f }: { f: DisplayFinding }) {
  const names = affectedTags(f)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.25rem',
      borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
    }}>
      <Info size={13} color="#38bdf8" style={{ flexShrink: 0 }} />
      <span style={{ fontSize: '0.78rem', color: 'var(--t2)', flex: 1, minWidth: '12rem' }}>{f.issue}</span>
      <ResourceTags names={names} />
      <CostBadge usd={f.cost_impact_usd} note={f.cost_impact_note} />
    </div>
  )
}

// Layout 1 — flat resources with no meaningful sub-resources (NSG, Key
// Vault, Public IP, ACR, ...): grouped by issue rather than by resource.
// Critical/Warning render as full cards, always expanded, Critical first.
// Info findings collapse into one <details> at the bottom.
export function FindingsGroupFlat({ findings, canAnalyze, onToggleStatus }: {
  findings: DisplayFinding[]
  canAnalyze: boolean
  onToggleStatus: (id: string, status: 'open' | 'dismissed') => void
}) {
  const [infoOpen, setInfoOpen] = useState(false)

  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const primary = sorted.filter(f => f.severity !== 'Info')
  const info = sorted.filter(f => f.severity === 'Info')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {primary.map((f, i) => (
        <IssueCard key={f.id || i} f={f} canAnalyze={canAnalyze} onToggleStatus={onToggleStatus} />
      ))}

      {info.length > 0 && (
        <details
          open={infoOpen}
          onToggle={e => setInfoOpen((e.target as HTMLDetailsElement).open)}
          style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}
        >
          <summary style={{
            padding: '0.6rem 0.75rem', cursor: 'pointer', fontSize: '0.78rem',
            color: 'var(--t2)', background: 'var(--panel)', listStyle: 'none',
          }}>
            {info.length} informational finding{info.length === 1 ? '' : 's'} — no action needed
          </summary>
          <div style={{ padding: '0 0.75rem' }}>
            {info.map((f, i) => <InfoRow key={f.id || i} f={f} />)}
          </div>
        </details>
      )}
    </div>
  )
}
