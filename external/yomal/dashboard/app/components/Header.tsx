'use client'

import Link from 'next/link'
import { ThemeToggle } from '../lib/theme'
import { useAuth } from '../lib/auth'
import { Badge } from './Badge'
import { roleConfig } from '../lib/utils'

interface Breadcrumb { label: string; href?: string }

interface HeaderProps {
  title?: string
  breadcrumbs?: Breadcrumb[]
  actions?: React.ReactNode
}

export function Header({ title, breadcrumbs, actions }: HeaderProps) {
  const { user } = useAuth()
  const rc = user ? roleConfig[user.role] : null

  return (
    <header style={{
      display: 'flex', alignItems: 'center',
      padding: '1rem 1.5rem',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg)',
      gap: '0.75rem',
      flexShrink: 0,
    }}>
      <div style={{ flex: 1 }}>
        {breadcrumbs ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}>
            {breadcrumbs.map((bc, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                {i > 0 && <span style={{ color: 'var(--t4)' }}>/</span>}
                {bc.href
                  ? <Link href={bc.href} style={{ color: 'var(--t2)', textDecoration: 'none' }}>{bc.label}</Link>
                  : <span style={{ color: 'var(--t1)', fontWeight: 500 }}>{bc.label}</span>
                }
              </span>
            ))}
          </div>
        ) : (
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, color: 'var(--t1)' }}>{title}</h1>
        )}
      </div>

      {actions}
      <ThemeToggle />

      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--t2)' }}>{user.email}</span>
          {rc && <Badge color={rc.color} label={rc.label} />}
        </div>
      )}
    </header>
  )
}
