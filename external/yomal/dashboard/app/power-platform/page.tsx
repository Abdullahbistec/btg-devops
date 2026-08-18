'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Header } from '../components/Header'
import { Badge } from '../components/Badge'
import { TableSkeleton } from '../components/Skeleton'
import { api } from '../lib/api'
import { shortId, statusConfig, triggerConfig } from '../lib/utils'
import type { Audit, Subscription } from '../types'

export default function PowerPlatformPage() {
  const [audits, setAudits] = useState<Audit[] | null>(null)
  // Power Platform audits store the tenant ID (not the subscriptions.id UUID)
  // in audits.subscription_id — see Task 7, which sets
  // subID = sub.TenantID for type='power_platform' rows, since Power
  // Platform has no subscription concept to use instead. So the join here
  // is against Subscription.tenant_id, not Subscription.id.
  const [ppTenantIds, setPpTenantIds] = useState<Set<string> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.listAudits(), api.listSubscriptions()])
      .then(([allAudits, subs]) => {
        const ppIds = new Set(
          (subs as Subscription[]).filter(s => s.type === 'power_platform').map(s => s.tenant_id)
        )
        setPpTenantIds(ppIds)
        setAudits(allAudits as Audit[])
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load Power Platform audits'))
  }, [])

  const ppAudits = audits && ppTenantIds
    ? audits.filter(a => ppTenantIds.has(a.subscription_id))
    : null

  return (
    <>
      <Header title="Power Platform" />
      {error && <div style={{ color: '#ef4444', padding: '1rem' }}>{error}</div>}
      {!ppAudits ? (
        <TableSkeleton rows={5} />
      ) : ppAudits.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--t3)' }}>
          No Power Platform tenant onboarded yet. Add one from the Subscriptions page.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
          {ppAudits.map(a => (
            <Link key={a.id} href={`/power-platform/${a.id}`} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '1rem', borderRadius: 10, border: '1px solid var(--border)',
              }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--t1)' }}>{a.subscription_name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--t3)' }}>{shortId(a.id)} · {a.created_at}</div>
                </div>
                <Badge color={statusConfig[a.status]?.color} label={statusConfig[a.status]?.label ?? a.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
