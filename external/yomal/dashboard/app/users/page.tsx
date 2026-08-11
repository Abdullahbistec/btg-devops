'use client'

import { useCallback, useEffect, useMemo, useState, FormEvent } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { Header } from '../components/Header'
import { Badge } from '../components/Badge'
import { Modal, AccessDenied } from '../components/Modal'
import { TableSkeleton } from '../components/Skeleton'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { roleConfig } from '../lib/utils'
import type { Role, User } from '../types'

export default function UsersPage() {
  const { user: me } = useAuth()
  const [users, setUsers]     = useState<User[] | null>(null)
  const [error, setError]     = useState('')
  const [modal, setModal]     = useState<'add' | 'edit' | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  const [formError, setFormError] = useState('')
  const [saving, setSaving]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole]         = useState<Role>('viewer')

  const load = useCallback(() => {
    api.listUsers()
      .then(setUsers)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load users'))
  }, [])

  useEffect(() => {
    if (me?.role === 'admin') load()
  }, [me?.role, load])

  const adminCount = useMemo(
    () => users?.filter(u => u.role === 'admin' && u.is_active).length ?? 0,
    [users]
  )

  if (me && me.role !== 'admin') {
    return (
      <>
        <Header title="User Management" />
        <AccessDenied message="Only admins can manage users." />
      </>
    )
  }

  function openAdd() {
    setEmail('')
    setPassword('')
    setRole('viewer')
    setFormError('')
    setEditing(null)
    setModal('add')
  }

  function openEdit(u: User) {
    setEditing(u)
    setRole(u.role)
    setFormError('')
    setModal('edit')
  }

  function isLastAdmin(u: User) {
    return u.role === 'admin' && adminCount <= 1
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')

    if (modal === 'add') {
      if (!email.trim() || !/\S+@\S+\.\S+/.test(email)) {
        setFormError('A valid email is required.')
        return
      }
      if (password.length < 8) {
        setFormError('Password must be at least 8 characters.')
        return
      }
    }

    if (modal === 'edit' && editing) {
      if (editing.id === me?.id && role !== 'admin') {
        setFormError('You cannot demote your own account.')
        return
      }
      if (isLastAdmin(editing) && role !== 'admin') {
        setFormError('This is the last admin account — promote another admin first.')
        return
      }
    }

    setSaving(true)
    try {
      if (modal === 'add') {
        await api.createUser({ email: email.trim(), password, role })
      } else if (editing) {
        await api.updateUser(editing.id, { role })
      }
      setModal(null)
      load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(u: User) {
    if (confirmDelete !== u.id) {
      setConfirmDelete(u.id)
      setTimeout(() => setConfirmDelete(c => (c === u.id ? null : c)), 4000)
      return
    }
    setConfirmDelete(null)
    try {
      await api.deleteUser(u.id)
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
      <Header title="User Management" />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--t3)', flex: 1 }}>
            {users ? `${users.length} account${users.length === 1 ? '' : 's'}` : '…'} · admin creates all users, no self-registration
          </p>
          <button className="btn-primary" onClick={openAdd}>Add User</button>
        </div>

        {error && (
          <div className="glass" style={{ padding: '1rem 1.25rem', color: '#ef4444', fontSize: '0.82rem' }}>
            {error}
          </div>
        )}

        {!users && !error && <TableSkeleton rows={4} cols={6} />}

        {users && (
          <div className="glass" style={{ padding: '0.5rem 1.25rem' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Email', 'Role', 'Status', 'Created At', 'Last Login', 'Actions'].map(h => (
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
                  {users.map(u => {
                    const rc = roleConfig[u.role] || { label: u.role, color: 'muted' }
                    const self = u.id === me?.id
                    const lastAdmin = isLastAdmin(u)
                    return (
                      <tr key={u.id} className="row-hover" style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.7rem 0.75rem', color: 'var(--t1)', fontWeight: 500 }}>
                          {u.email}
                          {self && <span style={{ color: 'var(--t4)', fontSize: '0.7rem', marginLeft: '0.375rem' }}>(you)</span>}
                        </td>
                        <td style={{ padding: '0.7rem 0.75rem' }}><Badge color={rc.color} label={rc.label} /></td>
                        <td style={{ padding: '0.7rem 0.75rem' }}>
                          <Badge color={u.is_active ? 'success' : 'muted'} label={u.is_active ? 'Active' : 'Inactive'} />
                        </td>
                        <td style={{ padding: '0.7rem 0.75rem', color: 'var(--t3)', whiteSpace: 'nowrap' }}>
                          {new Date(u.created_at).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '0.7rem 0.75rem', color: 'var(--t3)', whiteSpace: 'nowrap' }}>
                          {u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}
                        </td>
                        <td style={{ padding: '0.7rem 0.75rem' }}>
                          <div style={{ display: 'flex', gap: '0.25rem' }}>
                            <button style={iconBtn} title="Edit role" onClick={() => openEdit(u)}>
                              <Pencil size={14} />
                            </button>
                            <button
                              style={{
                                ...iconBtn,
                                color: self || lastAdmin ? 'var(--t4)' : '#ef4444',
                                cursor: self || lastAdmin ? 'not-allowed' : 'pointer',
                              }}
                              title={
                                self ? 'You cannot delete your own account'
                                : lastAdmin ? 'Cannot delete the last admin'
                                : confirmDelete === u.id ? 'Click again to confirm' : 'Delete'
                              }
                              disabled={self || lastAdmin}
                              onClick={() => handleDelete(u)}
                            >
                              {confirmDelete === u.id
                                ? <span style={{ fontSize: '0.68rem', fontWeight: 600, whiteSpace: 'nowrap' }}>Confirm?</span>
                                : <Trash2 size={14} />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Add User modal */}
      {modal === 'add' && (
        <Modal title="Add User" onClose={() => setModal(null)}>
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
              Email
              <input
                type="email" className="field"
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="user@bistecglobal.com"
                autoFocus
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Password
              <input
                type="password" className="field"
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Role
              <select
                className="field"
                value={role}
                onChange={e => setRole(e.target.value as Role)}
              >
                <option value="admin">Admin — full access, manage users & subscriptions</option>
                <option value="analyst">Analyst — view audits, run analysis, use chat</option>
                <option value="viewer">Viewer — read-only access to audit results</option>
              </select>
            </label>

            <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end', marginTop: '0.375rem' }}>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Add User'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit Role modal */}
      {modal === 'edit' && editing && (
        <Modal title="Edit Role" onClose={() => setModal(null)}>
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
              Email
              <input className="field" value={editing.email} disabled style={{ opacity: 0.6 }} />
              <span style={{ fontSize: '0.68rem', fontWeight: 400, color: 'var(--t4)' }}>
                Email cannot be changed.
              </span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 500, color: 'var(--t2)' }}>
              Role
              <select
                className="field"
                value={role}
                onChange={e => setRole(e.target.value as Role)}
              >
                <option value="admin">Admin</option>
                <option value="analyst">Analyst</option>
                <option value="viewer">Viewer</option>
              </select>
              {editing.id === me?.id && (
                <span style={{ fontSize: '0.68rem', fontWeight: 400, color: '#fbbf24' }}>
                  This is your own account — you cannot demote yourself.
                </span>
              )}
            </label>

            <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end', marginTop: '0.375rem' }}>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
