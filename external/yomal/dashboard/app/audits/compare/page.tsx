'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftRight, Sparkles } from 'lucide-react'
import { Header } from '../../components/Header'
import { Badge } from '../../components/Badge'
import { KPICard } from '../../components/KPICard'
import { TableSkeleton } from '../../components/Skeleton'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compareCounts } from '../../lib/compareAudits'
import { ResourceIcon, resourceMeta } from '../../lib/resourceMeta'
import { shortId } from '../../lib/utils'
import type { Audit } from '../../types'

function ComparePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const canChat = user?.role === 'admin' || user?.role === 'analyst'

  const [audits, setAudits] = useState<Audit[] | null>(null)
  const [error, setError]   = useState('')
  const [idA, setIdA] = useState(searchParams.get('a') || '')
  const [idB, setIdB] = useState(searchParams.get('b') || '')

  useEffect(() => {
    api.listAudits()
      .then(all => {
        const completed = all.filter(a => a.status === 'completed')
        setAudits(completed)
        // default: two most recent completed audits (B = newest, A = one before)
        setIdB(b => b || completed[0]?.id || '')
        setIdA(a => a || completed[1]?.id || '')
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load audits'))
  }, [])

  // keep the URL shareable
  useEffect(() => {
    if (idA && idB) {
      router.replace(`/audits/compare?a=${idA}&b=${idB}`, { scroll: false })
    }
  }, [idA, idB, router])

  const auditA = audits?.find(a => a.id === idA) || null
  const auditB = audits?.find(a => a.id === idB) || null
  const same = idA !== '' && idA === idB

  const diffs = useMemo(
    () => (auditA && auditB && !same) ? compareCounts(auditA.resource_counts, auditB.resource_counts) : [],
    [auditA, auditB, same]
  )
  const added    = diffs.filter(d => d.delta > 0).reduce((s, d) => s + d.delta, 0)
  const removed  = diffs.filter(d => d.delta < 0).reduce((s, d) => s - d.delta, 0)
  const changed  = diffs.filter(d => d.delta !== 0).length

  function swap() {
    setIdA(idB)
    setIdB(idA)
  }

  function askClaude() {
    if (!auditA || !auditB) return
    const q = `Compare this audit with audit ${shortId(auditA.id)} (from ${new Date(auditA.created_at).toLocaleDateString()}) — what changed and does anything look wrong?`
    router.push(`/audits/${auditB.id}?ask=${encodeURIComponent(q)}`)
  }

  const selectStyle: React.CSSProperties = {
    background: 'var(--panel)', border: '1px solid var(--border-strong)',
    borderRadius: 8, color: 'var(--t1)', padding: '0.45rem 0.75rem', fontSize: '0.82rem',
    cursor: 'pointer', fontFamily: 'ui-monospace, monospace', minWidth: 220,
  }

  function auditLabel(a: Audit) {
    return `${shortId(a.id)} · ${new Date(a.created_at).toLocaleString()}`
  }

  return (
    <>
      <Header breadcrumbs={[{ label: 'Audits', href: '/audits' }, { label: 'Compare' }]} />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

        {error && (
          <div className="glass" style={{ padding: '1rem 1.25rem', color: '#ef4444', fontSize: '0.82rem' }}>{error}</div>
        )}

        {!audits && !error && <TableSkeleton rows={6} cols={4} />}

        {audits && audits.length < 2 && (
          <div className="glass" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--t2)', fontSize: '0.875rem' }}>Not enough audits to compare.</p>
            <p style={{ color: 'var(--t3)', fontSize: '0.78rem', marginTop: '0.375rem' }}>
              You need at least two completed audits.
            </p>
          </div>
        )}

        {audits && audits.length >= 2 && (
          <>
            {/* pickers */}
            <div className="glass" style={{ padding: '1.25rem', display: 'flex', alignItems: 'flex-end', gap: '0.875rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 600, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Audit A (base)
                <select style={selectStyle} value={idA} onChange={e => setIdA(e.target.value)}>
                  {audits.map(a => <option key={a.id} value={a.id}>{auditLabel(a)}</option>)}
                </select>
              </label>

              <button
                className="btn-ghost"
                style={{ padding: '0.45rem 0.625rem', display: 'flex' }}
                onClick={swap}
                title="Swap A and B"
              >
                <ArrowLeftRight size={15} />
              </button>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 600, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Audit B (target)
                <select style={selectStyle} value={idB} onChange={e => setIdB(e.target.value)}>
                  {audits.map(a => <option key={a.id} value={a.id}>{auditLabel(a)}</option>)}
                </select>
              </label>

              <div style={{ flex: 1 }} />

              {canChat && auditA && auditB && !same && (
                <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }} onClick={askClaude}>
                  <Sparkles size={14} /> Ask Claude about this change
                </button>
              )}
            </div>

            {same && (
              <div className="glass" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--t3)', fontSize: '0.85rem' }}>
                Pick two different audits to compare.
              </div>
            )}

            {auditA && auditB && !same && (
              <>
                {/* summary tiles */}
                <div className="stagger grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <KPICard label="Resources Added"   value={added}   sub={`in ${shortId(auditB.id)} vs ${shortId(auditA.id)}`} accent="emerald" />
                  <KPICard label="Resources Removed" value={removed} sub={`in ${shortId(auditB.id)} vs ${shortId(auditA.id)}`} accent="amber" />
                  <KPICard label="Types Changed"     value={changed} sub={`of ${diffs.length} resource types`} accent="violet" />
                </div>

                {/* delta table */}
                <div className="glass animate-fade-in" style={{ padding: '0.5rem 1.25rem 0.75rem' }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          {['Resource Type', `A · ${shortId(auditA.id)}`, `B · ${shortId(auditB.id)}`, 'Change'].map(h => (
                            <th key={h} style={{
                              textAlign: 'left', padding: '0.625rem 0.75rem',
                              fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.06em',
                              textTransform: 'uppercase', color: 'var(--t3)',
                            }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {diffs.map(d => (
                          <tr key={d.slug} className="row-hover" style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '0.65rem 0.75rem' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                                <ResourceIcon slug={d.slug} size={14} />
                                <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--t1)' }}>{d.slug}</span>
                                <span className="hidden md:inline" style={{ fontSize: '0.72rem', color: 'var(--t4)' }}>
                                  {resourceMeta(d.slug).label}
                                </span>
                              </span>
                            </td>
                            <td style={{ padding: '0.65rem 0.75rem', color: 'var(--t2)', fontFamily: 'ui-monospace, monospace' }}>{d.before}</td>
                            <td style={{ padding: '0.65rem 0.75rem', color: 'var(--t2)', fontFamily: 'ui-monospace, monospace' }}>{d.after}</td>
                            <td style={{ padding: '0.65rem 0.75rem' }}>
                              {d.delta > 0 && <Badge color="success" label={`+${d.delta}`} />}
                              {d.delta < 0 && <Badge color="error" label={`−${Math.abs(d.delta)}`} />}
                              {d.delta === 0 && <Badge color="muted" label="0" />}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}

export default function ComparePage() {
  return (
    <Suspense fallback={<TableSkeleton rows={6} cols={4} />}>
      <ComparePageInner />
    </Suspense>
  )
}
