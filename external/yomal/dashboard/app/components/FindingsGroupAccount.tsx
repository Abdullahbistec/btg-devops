'use client'

import { useState } from 'react'
import { Database, ChevronDown, ChevronRight, EyeOff, RotateCcw } from 'lucide-react'
import { Badge } from './Badge'
import { CostBadge } from './CostBadge'
import { FixSteps } from './FixSteps'
import { EvidenceBlock } from './EvidenceBlock'
import { IssueCard } from './FindingsGroupFlat'
import { SEVERITY_DOT_COLOR, SEVERITY_ORDER, worstSeverity, type DisplayFinding } from '../lib/findingsLayout'
import { findingStatusConfig, findingAge } from '../lib/utils'

function sumCost(findings: DisplayFinding[]): number | null {
  const withCost = findings.filter(f => f.cost_impact_usd != null)
  if (withCost.length === 0) return null
  return withCost.reduce((sum, f) => sum + (f.cost_impact_usd || 0), 0)
}

// A finding shared identically across multiple accounts (affected_resources
// populated) vs. one unique to a single account (resource_name only). These
// render in structurally different sections — merging them is exactly what
// produced the "same account name appears twice" bug this replaces.
function isSharedFinding(f: DisplayFinding): boolean {
  return !!f.affected_resources && f.affected_resources.length > 0
}

function ChildRow({ childName, findings, canAnalyze, onToggleStatus }: {
  childName: string
  findings: DisplayFinding[]
  canAnalyze: boolean
  onToggleStatus: (id: string, status: 'open' | 'dismissed') => void
}) {
  const sev = worstSeverity(findings.map(f => f.severity))
  const cost = sumCost(findings)
  const costNote = findings.find(f => f.cost_impact_note)?.cost_impact_note

  return (
    <div style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_DOT_COLOR[sev], flexShrink: 0 }} />
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', color: 'var(--t1)', fontWeight: 600 }}>
          {childName}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <CostBadge usd={cost} note={cost == null ? (costNote || 'impact not estimated') : undefined} />
        </span>
      </div>
      {findings.map((f, i) => {
        const age = f.first_seen_at ? findingAge(f.first_seen_at) : null
        const st = f.status && f.status !== 'open' ? findingStatusConfig[f.status] : null
        return (
          <div key={f.id || i} style={{ marginTop: '0.4rem', paddingLeft: '1.1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem', flexWrap: 'wrap' }}>
              {age && <Badge color={age.color} label={age.label} />}
              {st && <Badge color={st.color} label={st.label} />}
              {canAnalyze && f.id && f.status !== 'resolved' && (
                <button
                  onClick={() => onToggleStatus(f.id!, f.status === 'dismissed' ? 'open' : 'dismissed')}
                  title={f.status === 'dismissed' ? 'Reopen this finding' : "Dismiss (won't fix / accepted risk)"}
                  style={{
                    background: 'none', border: '1px solid var(--border-strong)', borderRadius: 6,
                    color: 'var(--t3)', padding: '0.15rem 0.3rem', cursor: 'pointer', display: 'flex',
                  }}
                >
                  {f.status === 'dismissed' ? <RotateCcw size={11} /> : <EyeOff size={11} />}
                </button>
              )}
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--t2)', lineHeight: 1.5, opacity: f.status === 'dismissed' ? 0.55 : 1 }}>
              {f.issue}
            </p>
            <EvidenceBlock evidence={f.evidence} />
            <FixSteps steps={f.recommendation_steps} fallback={f.recommendation} />
          </div>
        )
      })}
    </div>
  )
}

function AccountCard({ accountName, findings, canAnalyze, onToggleStatus }: {
  accountName: string
  findings: DisplayFinding[]
  canAnalyze: boolean
  onToggleStatus: (id: string, status: 'open' | 'dismissed') => void
}) {
  const sev = worstSeverity(findings.map(f => f.severity))
  const needsAttention = sev === 'Critical' || sev === 'Warning'
  const [open, setOpen] = useState(needsAttention)

  const accountLevel = findings.filter(f => !f.child_resource_name)
  const byChild = new Map<string, DisplayFinding[]>()
  for (const f of findings) {
    if (!f.child_resource_name) continue
    if (!byChild.has(f.child_resource_name)) byChild.set(f.child_resource_name, [])
    byChild.get(f.child_resource_name)!.push(f)
  }
  // Children whose worst finding is Info-only read as "balanced" — combined
  // into one summary line instead of a full row each (no other signal is
  // available to tell "healthy" apart from "not mentioned at all", since
  // this component only sees resources that already have a finding).
  const attentionChildren: [string, DisplayFinding[]][] = []
  const balancedChildren: string[] = []
  for (const [name, fs] of byChild.entries()) {
    if (worstSeverity(fs.map(f => f.severity)) === 'Info') balancedChildren.push(name)
    else attentionChildren.push([name, fs])
  }

  const totalCost = sumCost(findings)
  const childCount = byChild.size

  return (
    <div style={{
      border: `1px solid ${needsAttention ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
      borderRadius: 8, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
          padding: '0.7rem 0.875rem', border: 'none', cursor: 'pointer', textAlign: 'left',
          background: needsAttention ? 'rgba(239,68,68,0.08)' : 'var(--panel)',
        }}
      >
        {open ? <ChevronDown size={14} color="var(--t3)" /> : <ChevronRight size={14} color="var(--t3)" />}
        <Database size={14} color={needsAttention ? '#ef4444' : 'var(--t3)'} />
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)' }}>
          {accountName}
        </span>
        {childCount > 0 && (
          <span style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>{childCount} database{childCount === 1 ? '' : 's'}</span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <CostBadge usd={totalCost} note={totalCost == null ? 'impact not estimated' : undefined} />
        </span>
      </button>

      {open && (
        <div style={{ padding: '0.25rem 0.875rem 0.5rem' }}>
          {accountLevel.map((f, i) => (
            <div key={f.id || `acct-${i}`} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_DOT_COLOR[f.severity], flexShrink: 0 }} />
                <span style={{ marginLeft: 'auto' }}><CostBadge usd={f.cost_impact_usd} note={f.cost_impact_note || 'impact not estimated'} /></span>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--t2)', lineHeight: 1.5 }}>{f.issue}</p>
              <EvidenceBlock evidence={f.evidence} />
              <FixSteps steps={f.recommendation_steps} fallback={f.recommendation} />
            </div>
          ))}

          {attentionChildren.map(([name, fs]) => (
            <ChildRow key={name} childName={name} findings={fs} canAnalyze={canAnalyze} onToggleStatus={onToggleStatus} />
          ))}

          {balancedChildren.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0', fontSize: '0.76rem', color: 'var(--t3)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_DOT_COLOR.Info, flexShrink: 0 }} />
              {balancedChildren.join(', ')} — balanced, no action needed
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Layout 2 — account-based resources (Cosmos DB, Storage, App Service
// Plan). Three structurally separate sections, never merged (a shared issue
// rendered as if it were one account's own card is exactly what produced
// the "same account name appears twice" bug this replaces):
//
//   1. Shared issues  — one issue-first card per finding whose
//      affected_resources spans multiple accounts. Never titled with a
//      single account's name.
//   2. Per account    — one card per account that has at least one finding
//      unique to it, expanding to its children (databases/containers/apps).
//      Never nests deeper than account → child.
//   3. A single collapsed line for accounts mentioned only via a shared
//      issue, with no unique finding of their own.
export function FindingsGroupAccount({ findings, canAnalyze, onToggleStatus }: {
  findings: DisplayFinding[]
  canAnalyze: boolean
  onToggleStatus: (id: string, status: 'open' | 'dismissed') => void
}) {
  const shared = findings.filter(isSharedFinding)
  const perAccountFindings = findings.filter(f => !isSharedFinding(f))

  const byAccount = new Map<string, DisplayFinding[]>()
  for (const f of perAccountFindings) {
    const key = f.resource_name || 'Unknown account'
    if (!byAccount.has(key)) byAccount.set(key, [])
    byAccount.get(key)!.push(f)
  }

  const accounts = Array.from(byAccount.entries()).sort(([, a], [, b]) => {
    const sa = worstSeverity(a.map(f => f.severity))
    const sb = worstSeverity(b.map(f => f.severity))
    return SEVERITY_ORDER[sa] - SEVERITY_ORDER[sb]
  })
  const needingAttention = accounts.filter(([, fs]) => {
    const s = worstSeverity(fs.map(f => f.severity))
    return s === 'Critical' || s === 'Warning'
  }).length

  // Every account name mentioned anywhere — via a shared finding's
  // affected_resources or via its own unique finding. Accounts that only
  // show up through a shared issue, with nothing unique to them, fold into
  // one collapsed line instead of an empty/near-empty card each.
  const accountsWithUniqueFindings = new Set(byAccount.keys())
  const mentioned = new Set<string>(accountsWithUniqueFindings)
  for (const f of shared) for (const name of f.affected_resources || []) mentioned.add(name)
  const noUniqueIssues = Array.from(mentioned).filter(n => !accountsWithUniqueFindings.has(n)).sort()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
      {shared.length > 0 && (
        <div>
          <p style={{ fontSize: '0.75rem', color: 'var(--t3)', marginBottom: '0.625rem' }}>
            Shared issue{shared.length === 1 ? '' : 's'} · identical across all affected accounts
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {shared.map((f, i) => (
              <IssueCard key={f.id || `shared-${i}`} f={f} canAnalyze={canAnalyze} onToggleStatus={onToggleStatus} />
            ))}
          </div>
        </div>
      )}

      {accounts.length > 0 && (
        <div>
          <p style={{ fontSize: '0.75rem', color: 'var(--t3)', marginBottom: '0.625rem' }}>
            Per account · {needingAttention} of {accounts.length} need{needingAttention === 1 ? 's' : ''} attention
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {accounts.map(([name, fs]) => (
              <AccountCard key={name} accountName={name} findings={fs} canAnalyze={canAnalyze} onToggleStatus={onToggleStatus} />
            ))}
          </div>
        </div>
      )}

      {noUniqueIssues.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.76rem', color: 'var(--t3)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_DOT_COLOR.Info, flexShrink: 0 }} />
          {noUniqueIssues.length} account{noUniqueIssues.length === 1 ? '' : 's'} — {noUniqueIssues.join(', ')} — no unique issues
        </div>
      )}
    </div>
  )
}
