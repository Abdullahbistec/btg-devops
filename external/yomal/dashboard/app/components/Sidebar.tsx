'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { LayoutDashboard, FileSearch, DollarSign, Globe, Users, Bell, AlertTriangle, LogOut, Menu, X } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { Badge } from './Badge'
import { roleConfig } from '../lib/utils'

const navItems = [
  { label: 'Dashboard',     href: '/',             icon: LayoutDashboard, exact: true  },
  { label: 'Audits',        href: '/audits',        icon: FileSearch,      exact: false },
  { label: 'Cost & Usage',  href: '/cost-usage',    icon: DollarSign,      exact: false },
]
// Visible to admin + analyst (same access as running Analyze) — not viewers,
// since this exposes an internal data-collection detail, not a finding.
const analystItems = [
  { label: 'Data Gaps',     href: '/data-gaps',     icon: AlertTriangle,   exact: false },
]
const adminItems = [
  { label: 'Subscriptions', href: '/subscriptions', icon: Globe,           exact: false },
  { label: 'Users',         href: '/users',         icon: Users,           exact: false },
  { label: 'Notifications', href: '/settings/notifications', icon: Bell,   exact: false },
]

function isActive(href: string, pathname: string, exact: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(href + '/')
}

function NavLink({ href, icon: Icon, label, exact, onClick }: {
  href: string; icon: typeof LayoutDashboard; label: string; exact: boolean; onClick?: () => void
}) {
  const pathname = usePathname()
  const active   = isActive(href, pathname, exact)

  return (
    <Link
      href={href}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.625rem',
        padding: '0.5rem 0.75rem',
        borderRadius: 8,
        fontSize: '0.875rem', fontWeight: 500,
        textDecoration: 'none',
        transition: 'background 0.12s, color 0.12s',
        background: active ? 'var(--acc-soft)' : 'transparent',
        color: active ? 'var(--acc)' : 'var(--t2)',
        borderLeft: active ? '2px solid var(--acc)' : '2px solid transparent',
        marginLeft: -2,
      }}
    >
      <Icon size={16} />
      {label}
    </Link>
  )
}

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const { user, logout } = useAuth()
  const rc = user ? roleConfig[user.role] : null

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--sidebar-bg)',
      borderRight: '1px solid var(--border)',
      padding: '1.25rem 1rem',
    }}>
      {/* brand */}
      <div style={{ marginBottom: '2rem', padding: '0 0.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: 'linear-gradient(135deg, #8B5CF6, #38BDF8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.65rem', fontWeight: 700, color: '#fff',
          }}>
            BTG
          </div>
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.05em' }}>
              BTG DEVOPS
            </div>
            <div style={{ fontSize: '0.62rem', color: 'var(--t4)', letterSpacing: '0.04em' }}>
              AZURE AUDIT CONSOLE
            </div>
          </div>
        </div>
      </div>

      {/* nav */}
      <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <div style={{ fontSize: '0.62rem', fontWeight: 600, color: 'var(--t4)', letterSpacing: '0.08em', marginBottom: '0.5rem', padding: '0 0.25rem' }}>
          MONITOR
        </div>
        {navItems.map(item => (
          <NavLink key={item.href} {...item} onClick={onClose} />
        ))}

        {(user?.role === 'admin' || user?.role === 'analyst') &&
          analystItems.map(item => (
            <NavLink key={item.href} {...item} onClick={onClose} />
          ))}

        {user?.role === 'admin' && (
          <>
            <div style={{ fontSize: '0.62rem', fontWeight: 600, color: 'var(--t4)', letterSpacing: '0.08em', margin: '1rem 0 0.5rem', padding: '0 0.25rem' }}>
              ADMINISTRATION
            </div>
            {adminItems.map(item => (
              <NavLink key={item.href} {...item} onClick={onClose} />
            ))}
          </>
        )}
      </nav>

      {/* footer */}
      {user && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            background: 'var(--acc-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.75rem', fontWeight: 700, color: 'var(--acc)',
          }}>
            {user.email[0].toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </div>
            {rc && <Badge color={rc.color} label={rc.label} />}
          </div>
          <button
            onClick={() => { onClose?.(); logout() }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)', padding: '0.25rem', borderRadius: 6, display: 'flex' }}
            title="Logout"
          >
            <LogOut size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* desktop */}
      <div className="hidden md:block" style={{ width: 240, flexShrink: 0, height: '100vh', position: 'sticky', top: 0 }}>
        <SidebarContent />
      </div>

      {/* mobile top bar */}
      <div className="flex md:hidden items-center" style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 52, zIndex: 40,
        background: 'var(--sidebar-bg)', borderBottom: '1px solid var(--border)',
        padding: '0 1rem', gap: '0.75rem',
      }}>
        <button onClick={() => setOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t2)', display: 'flex' }}>
          <Menu size={20} />
        </button>
        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--t1)' }}>BTG DevOps</span>
      </div>

      {/* mobile drawer */}
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50 }} />
          <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: 260, zIndex: 60 }}>
            <button
              onClick={() => setOpen(false)}
              style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', zIndex: 1, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t2)', display: 'flex' }}
            >
              <X size={18} />
            </button>
            <SidebarContent onClose={() => setOpen(false)} />
          </div>
        </>
      )}
    </>
  )
}
