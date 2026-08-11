'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Clock, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react'
import { Header } from '../components/Header'
import { Badge } from '../components/Badge'
import { AccessDenied } from '../components/Modal'
import { TableSkeleton } from '../components/Skeleton'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { DataGapEntry, ResolvedGapEntry } from '../types'

// Age/persistence color scale for how long a gap has been open (consecutive
// runs), reusing the same red/amber/blue convention as findingAge in
// lib/utils.ts — a gap open 5+ runs reads the same as a long-standing finding.
function streakBadge(n: number): { color: string; label: string } {
  if (n >= 5) return { color: 'error', label: `open ${n} runs` }
  if (n >= 2) return { color: 'warning', label: `open ${n} runs` }
  return { color: 'muted', label: 'new' }
}

function statusBadge(status: DataGapEntry['verification_status']): { color: string; label: string } | null {
  if (status === 'pending_verification') return { color: 'info', label: 'fix applied · awaiting next audit' }
  if (status === 'reopened') return { color: 'error', label: "fix didn't hold · reopened" }
  return null
}

function GapCard({ g, onMark }: { g: DataGapEntry; onMark: (g: DataGapEntry, note: string) => Promise<void> }) {
  const streak = streakBadge(g.consecutive_runs)
  const status = statusBadge(g.verification_status)
  const [showMarkForm, setShowMarkForm] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      await onMark(g, note)
      setShowMarkForm(false)
      setNote('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass" style={{ padding: '1rem 1.125rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem', flexWrap: 'wrap' }}>
        <AlertTriangle size={15} color={g.verification_status === 'reopened' ? '#ef4444' : '#fbbf24'} />
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem', fontWeight: 600, color: 'var(--t1)' }}>
          {g.scope}
        </span>
        <span style={{ fontSize: '0.78rem', color: 'var(--t3)' }}>
          {g.subscription_name || g.subscription_id}
        </span>
        <Badge color={streak.color} label={streak.label} />
        {status && <Badge color={status.color} label={status.label} />}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', color: 'var(--t4)' }}>
          <Clock size={11} />
          last seen {new Date(g.generated_at).toLocaleDateString()}
        </span>
      </div>

      <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {g.gaps.map((text, i) => (
          <li key={i} style={{ fontSize: '0.8rem', color: 'var(--t2)', lineHeight: 1.55 }}>{text}</li>
        ))}
      </ul>

      {g.mark && (
        <p style={{ fontSize: '0.72rem', color: 'var(--t4)', marginTop: '0.5rem' }}>
          Marked fixed {new Date(g.mark.marked_at).toLocaleDateString()}
          {g.mark.marked_by_email ? ` by ${g.mark.marked_by_email}` : ''}
          {g.mark.note ? ` — "${g.mark.note}"` : ''}
        </p>
      )}

      <div style={{ marginTop: '0.75rem' }}>
        {!showMarkForm ? (
          <button className="btn-ghost" style={{ fontSize: '0.76rem', padding: '0.35rem 0.7rem' }} onClick={() => setShowMarkForm(true)}>
            {g.verification_status === 'reopened' ? 'Mark as fixed again' : 'Mark as fixed'}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Optional note (e.g. what you changed)"
              style={{
                flex: 1, minWidth: '14rem', background: 'var(--panel)', border: '1px solid var(--border-strong)',
                borderRadius: 6, color: 'var(--t1)', padding: '0.4rem 0.6rem', fontSize: '0.78rem',
              }}
            />
            <button className="btn-primary" style={{ fontSize: '0.76rem', padding: '0.35rem 0.7rem' }} disabled={saving} onClick={submit}>
              {saving ? 'Saving…' : 'Confirm'}
            </button>
            <button className="btn-ghost" style={{ fontSize: '0.76rem', padding: '0.35rem 0.7rem' }} onClick={() => setShowMarkForm(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ResolvedSection({ resolved }: { resolved: ResolvedGapEntry[] }) {
  const [open, setOpen] = useState(false)
  if (resolved.length === 0) return null

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'none', border: 'none',
          color: 'var(--t3)', fontSize: '0.8rem', cursor: 'pointer', padding: 0,
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Recently resolved ({resolved.length})
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
          {resolved.map(r => (
            <div key={`${r.subscription_id}:${r.scope}`} style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.75rem',
              border: '1px solid var(--border)', borderRadius: 8, flexWrap: 'wrap',
            }}>
              <CheckCircle2 size={14} color="#22c55e" />
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', fontWeight: 600, color: 'var(--t1)' }}>
                {r.scope}
              </span>
              <span style={{ fontSize: '0.74rem', color: 'var(--t3)' }}>
                {r.subscription_name || r.subscription_id}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--t4)' }}>
                confirmed fixed {new Date(r.resolved_at).toLocaleDateString()}
                {r.marked_by_email ? ` · marked by ${r.marked_by_email}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DataGapsPage() {
  const { user } = useAuth()
  const [open, setOpen]         = useState<DataGapEntry[] | null>(null)
  const [resolved, setResolved] = useState<ResolvedGapEntry[]>([])
  const [error, setError]       = useState('')

  const load = useCallback(() => {
    api.listDataGaps()
      .then(v => { setOpen(v.open); setResolved(v.resolved) })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load data gaps'))
  }, [])

  useEffect(() => {
    if (user?.role === 'admin' || user?.role === 'analyst') load()
  }, [user?.role, load])

  if (user && user.role !== 'admin' && user.role !== 'analyst') {
    return (
      <>
        <Header title="Data Gaps" />
        <AccessDenied message="Only admins and analysts can view data gaps." />
      </>
    )
  }

  async function handleMark(g: DataGapEntry, note: string) {
    await api.markDataGapFixed(g.subscription_id, g.scope, note || undefined)
    load()
  }

  return (
    <>
      <Header title="Data Gaps" />
      <div style={{ padding: '1.5rem', maxWidth: 960, margin: '0 auto' }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--t3)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
          Data the deep-research agent needed but couldn&apos;t verify in its most recent analysis,
          per subscription and resource scope. Mark a gap as fixed right after applying the fix —
          it stays &quot;awaiting next audit&quot; until a new analysis confirms it, then moves to
          Recently Resolved automatically. If it reappears instead, it&apos;s flagged as reopened.
        </p>

        {error && (
          <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</p>
        )}

        {!open ? (
          <TableSkeleton rows={4} />
        ) : open.length === 0 ? (
          <div className="glass" style={{ padding: '2.5rem', textAlign: 'center' }}>
            <p style={{ fontSize: '0.9rem', color: 'var(--t2)' }}>No open data gaps.</p>
            <p style={{ fontSize: '0.78rem', color: 'var(--t4)', marginTop: '0.25rem' }}>
              Every scope&apos;s most recent analysis had everything it needed.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {open.map(g => (
              <GapCard key={`${g.subscription_id}:${g.scope}`} g={g} onMark={handleMark} />
            ))}
          </div>
        )}

        <ResolvedSection resolved={resolved} />
      </div>
    </>
  )
}
