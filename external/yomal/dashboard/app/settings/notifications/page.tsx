'use client'

import { useCallback, useEffect, useState } from 'react'
import { Header } from '../../components/Header'
import { AccessDenied } from '../../components/Modal'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { roleConfig } from '../../lib/utils'
import type { Role } from '../../types'

interface RoleSetting {
  role: Role
  enabled: boolean
  updated_at: string
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full access — the default recipients for audit-failed alerts.',
  analyst: 'View audits, run analysis, use chat.',
  viewer: 'Read-only access to audit results.',
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none',
        background: checked ? 'var(--acc)' : 'var(--border)',
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1, flexShrink: 0, transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 20 : 2,
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      }} />
    </button>
  )
}

export default function NotificationSettingsPage() {
  const { user: me } = useAuth()
  const [settings, setSettings] = useState<RoleSetting[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<Role | null>(null)

  const load = useCallback(() => {
    api.listNotificationSettings()
      .then(setSettings)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load notification settings'))
  }, [])

  useEffect(() => {
    if (me?.role === 'admin') load()
  }, [me?.role, load])

  if (me && me.role !== 'admin') {
    return (
      <>
        <Header title="Notification Settings" />
        <AccessDenied message="Only admins can manage notification settings." />
      </>
    )
  }

  async function toggleRole(role: Role, enabled: boolean) {
    setSaving(role)
    setError('')
    try {
      await api.updateNotificationSetting(role, enabled)
      setSettings(prev => prev && prev.map(s => (s.role === role ? { ...s, enabled } : s)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setSaving(null)
    }
  }

  return (
    <>
      <Header title="Notification Settings" />
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 640 }}>
        <p style={{ fontSize: '0.8rem', color: 'var(--t3)' }}>
          When a scheduled audit fails, an email alert is sent to every active user in an enabled role below.
          New users added to an enabled role are included automatically — no per-person list to maintain.
        </p>

        {error && (
          <div className="glass" style={{ padding: '1rem 1.25rem', color: '#ef4444', fontSize: '0.82rem' }}>
            {error}
          </div>
        )}

        {!settings && !error && <div style={{ color: 'var(--t3)', fontSize: '0.82rem' }}>Loading…</div>}

        {settings && (
          <div className="glass" style={{ padding: '0.5rem 1.25rem' }}>
            {settings.map((s, i) => {
              const rc = roleConfig[s.role] || { label: s.role, color: 'muted' }
              return (
                <div
                  key={s.role}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '1rem',
                    padding: '0.9rem 0.25rem',
                    borderBottom: i < settings.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)' }}>{rc.label}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--t3)' }}>{ROLE_DESCRIPTIONS[s.role]}</div>
                  </div>
                  <Toggle
                    checked={s.enabled}
                    disabled={saving === s.role}
                    onChange={() => toggleRole(s.role, !s.enabled)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
