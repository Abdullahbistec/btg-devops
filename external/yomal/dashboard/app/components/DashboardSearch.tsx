'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { Badge } from './Badge'
import { api } from '../lib/api'
import { shortId, statusConfig } from '../lib/utils'
import type { Audit, Finding } from '../types'

const severityIcons = {
  Critical: <AlertCircle size={13} color="#ef4444" />,
  Warning:  <AlertTriangle size={13} color="#fbbf24" />,
  Info:     <Info size={13} color="#38bdf8" />,
}

// Dashboard search: audits are filtered client-side (the page already holds
// the full list), findings hit /api/findings/search (the client only ever
// has the top 8, not a searchable corpus). Both result kinds navigate to
// the finding's/audit's detail page.
export function DashboardSearch({ audits }: { audits: Audit[] }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [findingResults, setFindingResults] = useState<Finding[]>([])
  const [searching, setSearching] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic sequence number: a response only lands if no newer query has
  // started since it was issued (drops stale/out-of-order results).
  const seqRef = useRef(0)

  const q = query.trim().toLowerCase()

  const auditResults = useMemo(() => {
    if (q.length < 2) return []
    return audits
      .filter(a =>
        shortId(a.id).toLowerCase().includes(q) ||
        (a.subscription_name || '').toLowerCase().includes(q) ||
        new Date(a.created_at).toLocaleDateString().toLowerCase().includes(q)
      )
      .slice(0, 5)
  }, [audits, q])

  // Findings search kicks off from the change handler (not an effect),
  // debounced 300ms.
  function handleChange(value: string) {
    setQuery(value)
    setOpen(true)
    setActiveIndex(0)
    if (timerRef.current) clearTimeout(timerRef.current)
    const seq = ++seqRef.current
    const trimmed = value.trim()
    if (trimmed.length < 2) {
      setFindingResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    timerRef.current = setTimeout(() => {
      api.searchFindings(trimmed)
        .then(r => { if (seq === seqRef.current) setFindingResults(r.findings) })
        .catch(() => { if (seq === seqRef.current) setFindingResults([]) })
        .finally(() => { if (seq === seqRef.current) setSearching(false) })
    }, 300)
  }

  // Cancel any in-flight debounce on unmount.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Flattened result list for keyboard navigation: audits first, then findings.
  const flat: { auditId: string }[] = [
    ...auditResults.map(a => ({ auditId: a.id })),
    ...findingResults.map(f => ({ auditId: f.audit_id })),
  ]

  function go(auditId: string) {
    setOpen(false)
    setQuery('')
    router.push(`/audits/${auditId}`)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return }
    if (flat.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && flat[activeIndex]) { e.preventDefault(); go(flat[activeIndex].auditId) }
  }

  const showDropdown = open && q.length >= 2
  const noMatches = showDropdown && !searching && auditResults.length === 0 && findingResults.length === 0

  const groupHeaderStyle: React.CSSProperties = {
    fontSize: '0.64rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
    color: 'var(--t3)', padding: '0.5rem 0.75rem 0.25rem',
  }
  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
    padding: '0.5rem 0.75rem', cursor: 'pointer', textAlign: 'left',
    background: active ? 'var(--hover)' : 'transparent', border: 'none',
  })

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', maxWidth: 340 }}>
      <div style={{ position: 'relative' }}>
        <Search size={14} color="var(--t3)" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
        <input
          className="field"
          placeholder="Search audits and findings…"
          value={query}
          onChange={e => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={{ width: '100%', paddingLeft: '2.1rem', fontSize: '0.8rem' }}
          aria-label="Search audits and findings"
        />
      </div>

      {showDropdown && (
        <div className="glass" style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 30,
          maxHeight: 380, overflowY: 'auto', padding: '0.25rem 0 0.4rem',
          border: '1px solid var(--border-strong)',
        }}>
          {auditResults.length > 0 && (
            <>
              <div style={groupHeaderStyle}>Audits</div>
              {auditResults.map((a, i) => {
                const sc = statusConfig[a.status] || { label: a.status, color: 'muted' }
                return (
                  <button key={a.id} style={rowStyle(i === activeIndex)}
                    onMouseDown={e => { e.preventDefault(); go(a.id) }}
                    onMouseEnter={() => setActiveIndex(i)}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', color: 'var(--acc)' }}>{shortId(a.id)}</span>
                    <span style={{ fontSize: '0.74rem', color: 'var(--t3)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {new Date(a.created_at).toLocaleDateString()}{a.subscription_name ? ` · ${a.subscription_name}` : ''}
                    </span>
                    <Badge color={sc.color} label={sc.label} />
                  </button>
                )
              })}
            </>
          )}

          {(findingResults.length > 0 || searching) && (
            <>
              <div style={groupHeaderStyle}>Findings{searching ? ' …' : ''}</div>
              {findingResults.map((f, i) => {
                const idx = auditResults.length + i
                return (
                  <button key={f.id} style={rowStyle(idx === activeIndex)}
                    onMouseDown={e => { e.preventDefault(); go(f.audit_id) }}
                    onMouseEnter={() => setActiveIndex(idx)}>
                    {severityIcons[f.severity] || severityIcons.Info}
                    <span style={{ fontSize: '0.76rem', color: 'var(--t1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.issue}
                    </span>
                    <span style={{ fontSize: '0.66rem', color: 'var(--t4)', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                      {f.resource_name || f.resource_type}
                    </span>
                  </button>
                )
              })}
            </>
          )}

          {noMatches && (
            <p style={{ fontSize: '0.78rem', color: 'var(--t3)', padding: '0.75rem' }}>
              No matches for “{query.trim()}”.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
