'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Header } from '../../components/Header'
import { Badge } from '../../components/Badge'
import { AnalysisPanel } from '../../components/AnalysisPanel'
import { RawDataSection } from '../../components/RawDataSection'
import { ChatDock } from '../../components/ChatDock'
import { DetailSkeleton } from '../../components/Skeleton'
import { api } from '../../lib/api'
import { shortId, statusConfig } from '../../lib/utils'
import type { AuditDetail } from '../../types'

// A thin, Power Platform-titled wrapper around the same AnalysisPanel /
// RawDataSection / ChatDock trio app/audits/[id]/page.tsx uses — those
// components are already fully generic over whatever resource-type keys
// appear in resourceCounts (buildScopeGroups just does
// Object.keys(resourceCounts)), so no PP-specific findings-rendering code
// is needed here. hasCost/usageTypes are passed as false/[] since a PP
// audit's cost_data/usage_data columns are never populated (Task 7 skips
// that extraction block entirely for type='power_platform').
export default function PowerPlatformDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [audit, setAudit]   = useState<AuditDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError]   = useState('')
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
    { label: 'Power Platform', href: '/power-platform' },
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

  const sc = statusConfig[audit.status] || { label: audit.status, color: 'muted' }
  const counts = audit.resource_counts || {}
  const failed = audit.status === 'failed'

  return (
    <>
      <Header breadcrumbs={breadcrumbs} />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

        <div className="glass animate-fade-in" style={{ padding: '0.7rem 1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--t1)' }}>
              {audit.subscription_name || 'Power Platform Tenant'}
            </span>
            <Badge color={sc.color} label={sc.label} />
            <span style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>
              {new Date(audit.created_at).toLocaleString()}
            </span>
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

        {!failed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <AnalysisPanel
              auditId={audit.id}
              resourceCounts={counts}
              initialStore={audit.claude_analysis}
              hasCost={false}
              usageTypes={[]}
              onScopeChange={setAnalyzeScope}
            />
            <RawDataSection key={analyzeScope} auditId={audit.id} resourceCounts={counts} selectedType={analyzeScope} />
          </div>
        )}
      </div>

      {!failed && (
        <ChatDock auditId={audit.id} resourceCounts={counts} hasCost={false} usageTypes={[]} />
      )}
    </>
  )
}
