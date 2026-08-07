'use client';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTheme } from '@/hooks/useTheme';

const NAV = [
  {
    group: 'Monitor',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: <GridIcon /> },
      { href: '/audits',    label: 'Audits',    icon: <ChartIcon /> },
      { href: '/compare',   label: 'Compare',   icon: <GridIcon /> },
      { href: '/cost',      label: 'Cost & Usage', icon: <ClockIcon /> },
    ],
  },
  {
    group: 'Analysis',
    items: [
      { href: '/dashboard?scope=azure', label: '▸ Azure',         icon: null },
      { href: '/dashboard?scope=pp',    label: '▸ Power Platform', icon: null },
      { href: '/power-automate',        label: '▸ Power Automate', icon: null },
    ],
  },
  {
    group: 'Reports',
    items: [
      { href: '/reports',   label: 'Reports',   icon: <DocIcon /> },
      { href: '/settings',  label: 'Settings',  icon: <CogIcon /> },
    ],
  },
  {
    group: 'Admin',
    items: [
      { href: '/admin', label: 'Admin Panel', icon: <ShieldIcon /> },
    ],
  },
];

interface MeInfo { email: string; name: string; role: string }

export default function Sidebar() {
  const path = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [me, setMe] = useState<MeInfo | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      setMe(d);
      if (d.role === 'admin') {
        fetch('/api/auth/users?status=pending')
          .then(r => r.ok ? r.json() : [])
          .then(list => setPendingCount(Array.isArray(list) ? list.length : 0))
          .catch(() => {});
      }
    });
  }, []);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  const [hoveredHref, setHoveredHref] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const isAdmin = !me || me.role === 'admin';
  const initials = me?.name ? me.name.slice(0, 1).toUpperCase() : me?.email ? me.email.slice(0, 1).toUpperCase() : 'A';
  const displayName = me?.name || me?.email?.split('@')[0] || 'admin';

  return (
    <aside className="glass-sb" style={{
      width: 150, flexShrink: 0,
      display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingTop: 12,
    }}>
      {/* Brand */}
      <div style={{ padding: '12px 14px 14px', borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {/* Hexagon logo icon */}
          <svg width="34" height="38" viewBox="0 0 36 40" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id="hexGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#74D7F7" />
                <stop offset="100%" stopColor="#2B7FCC" />
              </linearGradient>
            </defs>
            {/* Flat-top hexagon */}
            <polygon points="18,1 34,10 34,30 18,39 2,30 2,10" fill="url(#hexGrad)" />
            {/* Two interlocking rings (chain/infinity symbol) */}
            <circle cx="12.5" cy="20" r="5.5" fill="none" stroke="white" strokeWidth="2.2" />
            <circle cx="23.5" cy="20" r="5.5" fill="none" stroke="white" strokeWidth="2.2" />
            {/* Overlap mask — cover the inner crossing lines to look like real links */}
            <rect x="15.5" y="14.5" width="5" height="11" fill="url(#hexGrad)" />
          </svg>

          {/* Text lockup */}
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, lineHeight: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 300, color: 'rgba(160,174,207,0.55)', letterSpacing: '0.04em' }}>BTG</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: '#00C2FF', letterSpacing: '0.01em' }}>DevOps</span>
            </div>
            <div style={{ fontSize: 8, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.14em', textTransform: 'uppercase', marginTop: 3 }}>
              Security Console
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {NAV.map(({ group, items }) => {
          const visibleItems = items.filter(item => {
            const isAdminOnly = item.href === '/settings' || item.href === '/admin';
            return !isAdminOnly || isAdmin;
          });
          if (visibleItems.length === 0) return null;
          return (
          <div key={group}>
            <div style={{ padding: '10px 14px 4px', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dim)' }}>
              {group}
            </div>
            {items.map(item => {
              const base = item.href.split('?')[0];
              const isActive = path === base || path.startsWith(base + '/') || path + (path.includes('?') ? '' : '') === item.href;
              const isAdminOnly = item.href === '/settings' || item.href === '/admin';
              const isHovered = hoveredHref === item.href;
              if (isAdminOnly && !isAdmin) return null;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onMouseEnter={() => setHoveredHref(item.href)}
                  onMouseLeave={() => setHoveredHref(null)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    margin: '2px 8px', padding: '7px 10px',
                    fontSize: 12, fontWeight: isActive ? 700 : 500,
                    borderRadius: 8,
                    color: isActive ? 'var(--accent)' : isHovered ? 'var(--text)' : 'var(--muted)',
                    background: isActive
                      ? 'rgba(0,194,255,0.12)'
                      : isHovered
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(255,255,255,0.02)',
                    border: isActive
                      ? '1px solid rgba(0,194,255,0.35)'
                      : isHovered
                      ? '1px solid rgba(255,255,255,0.12)'
                      : '1px solid rgba(255,255,255,0.05)',
                    boxShadow: isActive
                      ? '0 0 12px rgba(0,194,255,0.18), inset 0 1px 0 rgba(0,194,255,0.1)'
                      : isHovered
                      ? '0 2px 8px rgba(0,0,0,0.15)'
                      : 'none',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {item.icon}
                  {item.label}
                  {(item.href === '/settings' || item.href === '/admin') && pendingCount > 0 && (
                    <span style={{
                      marginLeft: 'auto', background: '#FF4757', color: '#fff',
                      fontSize: 9, fontWeight: 800, borderRadius: 999,
                      padding: '1px 5px', minWidth: 16, textAlign: 'center', lineHeight: '14px',
                    }}>{pendingCount}</span>
                  )}
                </Link>
              );
            })}
          </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* User info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 24, height: 24, borderRadius: '50%', background: isAdmin ? 'var(--accent2)' : 'var(--muted)',
            fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0,
          }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {displayName}
            </div>
            <div style={{ fontSize: 8, color: isAdmin ? 'var(--accent)' : 'var(--dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {me?.role ?? 'admin'}
            </div>
          </div>
        </div>

        {/* Theme toggle */}
        <button onClick={toggle}
          onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'rgba(255,255,255,0.06)'; el.style.borderColor = 'rgba(255,255,255,0.2)'; el.style.color = 'var(--text)'; }}
          onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'transparent'; el.style.borderColor = 'var(--border)'; el.style.color = 'var(--muted)'; }}
          style={{
            width: '100%', padding: '5px 0', borderRadius: 8, fontSize: 10, fontWeight: 700,
            background: 'transparent', border: '1px solid var(--border)',
            color: 'var(--muted)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            transition: 'all 0.15s ease',
          }}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          {theme === 'dark' ? 'Light' : 'Dark'} mode
        </button>

        {/* Sign out */}
        <button onClick={logout} style={{
          width: '100%', padding: '5px 0', borderRadius: 4, fontSize: 10, fontWeight: 700,
          background: 'transparent', border: '1px solid rgba(255,71,87,0.35)',
          color: 'var(--crit)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          transition: 'background 0.15s',
        }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,71,87,0.1)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          <LogoutIcon /> Sign Out
        </button>
      </div>
    </aside>
  );
}

function LogoutIcon() {
  return <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 1H2a1 1 0 00-1 1v7a1 1 0 001 1h2M7 8l3-2.5L7 3M4 5.5h6"/></svg>;
}
function GridIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="1" width="4.5" height="4.5" rx="1"/><rect x="7.5" y="1" width="4.5" height="4.5" rx="1"/><rect x="1" y="7.5" width="4.5" height="4.5" rx="1"/><rect x="7.5" y="7.5" width="4.5" height="4.5" rx="1"/></svg>;
}
function ChartIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 10l3-3 2.5 2 4-5"/></svg>;
}
function ClockIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6.5" cy="6.5" r="5"/><path d="M6.5 4v2.5l1.5 1.5"/></svg>;
}
function DocIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3h7v7H3z"/><path d="M5 6h3M5 8h2"/></svg>;
}
function CogIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6.5" cy="6.5" r="2"/><path d="M6.5 1v1.5M6.5 10v1.5M1 6.5h1.5M10 6.5h1.5M2.6 2.6l1.1 1.1M9.3 9.3l1.1 1.1M2.6 10.4l1.1-1.1M9.3 3.7l1.1-1.1"/></svg>;
}
function SunIcon() {
  return <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="5.5" cy="5.5" r="2"/><path d="M5.5 1v1M5.5 9v1M1 5.5h1M9 5.5h1M2.6 2.6l.7.7M7.7 7.7l.7.7M2.6 8.4l.7-.7M7.7 3.3l.7-.7"/></svg>;
}
function MoonIcon() {
  return <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 6.5A4 4 0 014.5 2a4 4 0 100 7 4 4 0 004.5-2.5z"/></svg>;
}
function ShieldIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6.5 1.5L2 3.5v4c0 2.5 2 4 4.5 4.5C9 11.5 11 10 11 7.5v-4L6.5 1.5z"/></svg>;
}
