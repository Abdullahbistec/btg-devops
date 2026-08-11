'use client'

import { usePathname } from 'next/navigation'
import { Sidebar } from './Sidebar'

const NO_SIDEBAR = ['/login']

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (NO_SIDEBAR.includes(pathname)) {
    return <>{children}</>
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: 'var(--bg)',
        backgroundImage: `
          radial-gradient(ellipse at 20% 50%, rgba(139,92,246,0.03) 0%, transparent 60%),
          radial-gradient(ellipse at 80% 20%, rgba(56,189,248,0.025) 0%, transparent 60%)
        `,
      }}>
        <main style={{ flex: 1, overflowY: 'auto' }} className="pt-[52px] md:pt-0">
          {children}
        </main>
      </div>
    </div>
  )
}
