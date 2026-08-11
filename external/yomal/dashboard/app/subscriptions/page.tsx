'use client'

import { useCallback, useEffect, useState, FormEvent } from 'react'
import { Pencil, Power, Trash2 } from 'lucide-react'
import { Header } from '../components/Header'
import { Badge } from '../components/Badge'
import { Modal, AccessDenied } from '../components/Modal'
import { TableSkeleton } from '../components/Skeleton'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { Subscription } from '../types'

function truncGuid(v: string): string {
  return v && v.length > 13 ? v.slice(0, 13) + '…' : v || '—'
}

const mono: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: 'var(--t2)' }

interface FormState {
  name: string
  subscription_id: string
  tenant_id: string
  client_id: string
  client_secret: string
  is_active: boolean
}

const emptyForm: FormState = {
  name: '', subscription_id: '', tenant_id: '', client_id: '', client_secret: '', is_active: true,
}

export default function SubscriptionsPage() {
  const { user } = useAuth()
  const [subs, setSubs]       = useState<Subscription[] | null>(null)
  const [error, setError]     = useState('')
  const [modal, setModal]     = useState<'add' | 'edit' | null>(null)
  const [editing, setEditing] = useState<Subscription | null>(null)
  const [form, setForm]       = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState('')
  const [saving, setSaving]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(() => {
    api.listSubscriptions()
      .then(setSubs)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load subscriptions'))
  }, [])

  useEffect(() => {
    if (user?.role === 'admin') load()
  }, [user?.role, load])

  if (user && user.role !== 'admin') {
    return (
      <>
        <Header title="Subscriptions" />
        <AccessDenied message="Only admins can manage subscriptions." />
      </>
    )
  }

  function openAdd() {
    setForm(emptyForm)
    setFormError('')
    setEditing(null)
    setModal('add')
  }

  function openEdit(sub: Subscription) {
    setForm({
      name: sub.name,
      subscription_id: sub.subscription_id,
      tenant_id: sub.tenant_id,
      client_id: sub.client_id,
      client_secret: '',
      is_active: sub.is_active,
    })
    setFormError('')
    setEditing(sub)
    setModal('edit')
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')

    if (!form.name.trim() || !form.subscription_id.trim()) {
      setFormError('Name and Subscription ID are required.')
      return
    }
    if (modal === 'add' && (!form.tenant_id.trim() || !form.client_id.trim() || !form.client_secret)) {
      setFormError('All fields including client secret are required when adding.')
      return
    }

    setSaving(true)
    try {
      if (modal === 'add') {
        await api.createSubscription({
          name: form.name.trim(),
          subscription_id: form.subscription_id.trim(),
          tenant_id: form.tenant_id.trim(),
          client_id: form.client_id.trim(),
          client_secret: form.client_secret,
        })
      } else if (editing) {
        const payload: Record<string, unknown> = {
          name: form.name.trim(),
          tenant_id: form.tenant_id.trim(),
          client_id: form.client_id.trim(),
          is_active: form.is_active,
        }
        if (form.client_secret) payload.client_secret = form.client_secret
        await api.updateSubscription(editing.id, payload)
      }
      setModal(null)
      load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(sub: Subscription) {
    try {
      await api.updateSubscription(sub.id, { is_active: !sub.is_active })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    }
  }

  async function handleDelete(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      setTimeout(() => setConfirmDelete(c => (c === id ? null : c)), 4000)
      return
    }
    setConfirmDelete(null)
    try {
      await api.deleteSubscription(id)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const iconBtn: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)',
    padding: '0.3rem', borderRadius: 6, display: 'flex',
  }

  return (
    <>
      <Header title="Subscriptions" />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--t3)', flex: 1 }}>
            {subs ? `${subs.length} Azure subscription${subs.length === 1 ? '' : 's'}` : '…'} · client secrets are AES-256 encrypted at rest and never shown again
          </p>
          <button className="btn-primary" onClick={openAdd}>Add Subscription</button>
        </div>

        {error && (
          <div className="glass" style={{ padding: '1rem 1.25rem', color: '#ef4444', fontSize: '0.82rem' }}>
            {error}
          </div>
        )}

        {!subs && !error && <TableSkeleton rows={4} cols={7} />}

        {subs && subs.length === 0 && (
          <div className="glass" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--t2)', fontSize: '0.875rem' }}>No subscriptions yet.</p>
            <p style={{ color: 'var(--t3)', fontSize: '0.78rem', marginTop: '0.375rem' }}>
              Add an Azure subscription to include it in the daily audits.
            </p>
          </div>
        )}

        {subs && subs.length > 0 && (
          <div className="glass" style={{ padding: '0.5rem 1.25rem' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Name', 'Subscription ID', 'Tenant ID', 'Client ID', 'Status', 'Last Audit', 'Actions'].map(h => (
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
                  {subs.map(sub => (
                    <tr key={sub.id} className="row-hover" style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.7rem 0.75rem', color: 'var(--t1)', fontWeight: 500 }}>{sub.name}</td>
                      <td style={{ padding: '0.7rem 0.75rem', ...mono }}>{truncGuid(sub.subscription_id)}</td>
                      <td style={{ padding: '0.7rem 0.75rem', ...mono }}>{truncGuid(sub.tenant_id)}</td>
                      <td style={{ padding: '0.7rem 0.75rem', ...mono }}>{truncGuid(sub.client_id)}</td>
                      <td style={{ padding: '0.7rem 0.75rem' }}>
                        <Badge color={sub.is_active ? 'success' : 'muted'} label={sub.is_active ? 'Active' : 'Inactive'} />
                      </td>
                      <td style={{ padding: '0.7rem 0.75rem', color: 'var(--t3)', whiteSpace: 'nowrap' }}>
                        {sub.last_audit_at ? new Date(sub.last_audit_at).toLocaleString() : 'Never'}
                      </td>
                      <td style={{ padding: '0.7rem 0.75rem' }}>
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <button style={iconBtn} title="Edit" onClick={() => openEdit(sub)}>
                            <Pencil size={14} />
                          </button>
                          <button
                            style={{ ...iconBtn, color: sub.is_active ? '#22c55e' : 'var(--t4)' }}
                            title={sub.is_active ? 'Deactivate' : 'Activate'}
                            onClick={() => toggleActive(sub)}
                          >
                            <Power size={14} />
                          </button>
                          <button
                            style={{ ...iconBtn, color: '#ef4444' }}
                            title={confirmDelete === sub.id ? 'Click again to confirm' : 'Delete'}
                            onClick={() => handleDelete(sub.id)}
                          >
                            {confirmDelete === sub.id
                              ? <span style={{ fontSize: '0.68rem', fontWeight: 600, whiteSpace: 'nowrap' }}>Confirm?</span>
                              : <Trash2 size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Add / Edit modal */}
      {modal && (
        <Modal title={modal === 'add' ? 'Add Subscription' : 'Edit Subscription'} onClose={() => setModal(null)}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            {formError && (
              <div style={{
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', color: '#ef4444',
              }}>
                {formError}
              </div>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Name
              <input className="field" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Production Subscription" />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Subscription ID
              <input
                className="field" style={{ fontFamily: 'ui-monospace, monospace' }}
                value={form.subscription_id}
                onChange={e => setForm(f => ({ ...f, subscription_id: e.target.value }))}
                placeholder="00000000-0000-0000-0000-000000000000"
                disabled={modal === 'edit'}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Tenant ID
              <input
                className="field" style={{ fontFamily: 'ui-monospace, monospace' }}
                value={form.tenant_id}
                onChange={e => setForm(f => ({ ...f, tenant_id: e.target.value }))}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Client ID
              <input
                className="field" style={{ fontFamily: 'ui-monospace, monospace' }}
                value={form.client_id}
                onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Client Secret
              <input
                type="password"
                className="field" style={{ fontFamily: 'ui-monospace, monospace' }}
                value={form.client_secret}
                onChange={e => setForm(f => ({ ...f, client_secret: e.target.value }))}
                placeholder={modal === 'edit' ? 'Leave blank to keep existing secret' : '••••••••••••••••'}
              />
              <span style={{ fontSize: '0.68rem', fontWeight: 400, color: 'var(--t4)' }}>
                Encrypted with AES-256-GCM before saving. Write-only — never shown again.
              </span>
            </label>

            {modal === 'edit' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.8rem', color: 'var(--t2)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                  style={{ width: 15, height: 15, accentColor: 'var(--acc)' }}
                />
                Active — include in daily audits (1:30 PM SL time)
              </label>
            )}

            <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end', marginTop: '0.375rem' }}>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : modal === 'add' ? 'Add Subscription' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
