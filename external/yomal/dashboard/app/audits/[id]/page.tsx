'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Header } from '../../components/Header'
import { Badge } from '../../components/Badge'
import { AnalysisPanel } from '../../components/AnalysisPanel'
import { ChatDock } from '../../components/ChatDock'
import { RawDataSection } from '../../components/RawDataSection'
import { DetailSkeleton } from '../../components/Skeleton'
import { api } from '../../lib/api'
import { resourceMeta } from '../../lib/resourceMeta'
import { formatNumber, shortId, statusConfig, triggerConfig } from '../../lib/utils'
import type { AuditDetail } from '../../types'

// How many resource-type chips to show inline before collapsing the rest
// into "+N more" — keeps the summary a single line instead of the old
// full-height grid of all 12 types.
const INLINE_CHIP_COUNT = 3

export default function AuditDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [audit, setAudit]     = useState<AuditDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError]     = useState('')
  const [analyzeScope, setAnalyzeScope] = useState<string>('')

  useEffect(() => {
    api.getAudit(id)
      .then(setAudit)
      .catch(e => {
        const msg = e instanceof Error ? e.message : ''
        if (msg.includes('not found') || msg.includes('404')) setNotFound(true)
        else setError(msg || 'Failed to load audit')
      })
  }, [id])

  const breadcrumbs = [
    { label: 'Audits', href: '/audits' },
    { label: shortId(id) },
  ]

  if (notFound) {
    return (
      <>
        <Header breadcrumbs={breadcrumbs} />
        <div style={{ padding: '3rem 1.5rem', textAlign: 'center', color: 'var(--t2)', fontSize: '0.9rem' }}>
          Audit not found.
        </div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <Header breadcrumbs={breadcrumbs} />
        <div style={{ padding: '3rem 1.5rem', textAlign: 'center', color: '#ef4444', fontSize: '0.875rem' }}>
          {error}
        </div>
      </>
    )
  }

  if (!audit) {
    return (
      <>
        <Header breadcrumbs={breadcrumbs} />
        <DetailSkeleton />
      </>
    )
  }

  const sc = statusConfig[audit.status]        || { label: audit.status, color: 'muted' }
  const tc = triggerConfig[audit.trigger_type] || { label: audit.trigger_type, color: 'muted' }
  const counts = audit.resource_counts || {}
  const sortedSlugs = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  const inlineSlugs = sortedSlugs.slice(0, INLINE_CHIP_COUNT)
  const overflowCount = sortedSlugs.length - inlineSlugs.length
  const total  = Object.values(counts).reduce((s, n) => s + n, 0)
  const failed = audit.status === 'failed'

  return (
    <>
      <Header breadcrumbs={breadcrumbs} />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

        {/* Section A — a single-line summary strip. Full per-type resource
            counts live in Raw Resource Data below, one click away, instead
            of a full-height grid competing with AI Analysis for attention. */}
        <div className="glass animate-fade-in" style={{ padding: '0.7rem 1rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', fontWeight: 700, color: 'var(--t1)' }}>
                {shortId(audit.id)}
              </span>
              <Badge color={sc.color} label={sc.label} />
              <Badge color={tc.color} label={tc.label} />
            </div>
            <p style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>
              {new Date(audit.created_at).toLocaleString()} · {audit.subscription_name || 'subscription'} · {shortId(audit.subscription_id)}…
            </p>

            {!failed && (
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginLeft: 'auto' }}>
                {inlineSlugs.map(slug => (
                  <span key={slug} className="bdg bdg-muted" style={{ fontFamily: 'ui-monospace, monospace' }}>
                    {resourceMeta(slug).label} <b style={{ color: 'var(--t1)' }}>{counts[slug]}</b>
                  </span>
                ))}
                {overflowCount > 0 && (
                  <span className="bdg bdg-muted">+{overflowCount} more</span>
                )}
                <span className="bdg bdg-muted" style={{ color: 'var(--t1)' }}>
                  <b>{formatNumber(total)}</b>&nbsp;total
                </span>
              </div>
            )}
          </div>

          {failed && (
            <pre style={{
              marginTop: '0.75rem', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: 8, padding: '0.875rem 1rem', fontSize: '0.78rem', color: '#ef4444',
              fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {audit.error_message || 'Audit failed with no error message.'}
            </pre>
          )}
        </div>

        {/* Sections B + D — only for non-failed audits; chat lives in the
            floating ChatDock so analysis gets the full page width */}
        {!failed && (
          <div className="flex flex-col gap-5">
            <AnalysisPanel
              auditId={audit.id}
              resourceCounts={counts}
              initialStore={audit.claude_analysis}
              hasCost={audit.has_cost}
              usageTypes={audit.usage_types}
              onScopeChange={setAnalyzeScope}
            />
            <RawDataSection key={analyzeScope} auditId={audit.id} resourceCounts={counts} selectedType={analyzeScope} />
          </div>
        )}
      </div>

      {!failed && (
        <ChatDock
          auditId={audit.id}
          resourceCounts={counts}
          hasCost={audit.has_cost}
          usageTypes={audit.usage_types}
        />
      )}
    </>
  )
}
