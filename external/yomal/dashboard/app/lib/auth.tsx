'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { Role, SessionUser } from '../types'

interface AuthCtx {
  user: SessionUser | null
  ready: boolean
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => void
}

const AuthContext = createContext<AuthCtx>({
  user: null,
  ready: false,
  login: async () => ({ ok: false }),
  logout: () => {},
})

const TOKEN_KEY = 'btg_token'
const USER_KEY  = 'btg_user'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const raw   = localStorage.getItem(USER_KEY)
    const token = localStorage.getItem(TOKEN_KEY)
    if (raw && token) {
      try { setUser(JSON.parse(raw)) } catch {
        localStorage.removeItem(USER_KEY)
        localStorage.removeItem(TOKEN_KEY)
      }
    }
    setReady(true)
  }, [])

  async function login(email: string, password: string) {
    try {
      const res  = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data.error || 'Login failed' }

      const sessionUser: SessionUser = {
        id:    data.user.id,
        email: data.user.email,
        role:  data.user.role as Role,
      }
      localStorage.setItem(TOKEN_KEY, data.token)
      localStorage.setItem(USER_KEY, JSON.stringify(sessionUser))
      setUser(sessionUser)
      return { ok: true }
    } catch {
      return { ok: false, error: 'Network error' }
    }
  }

  function logout() {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, ready, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

const PUBLIC = ['/login']

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth()
  const router   = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!ready) return
    const isPublic = PUBLIC.includes(pathname)
    if (!user && !isPublic) router.replace('/login')
    if (user  &&  isPublic) router.replace('/')
  }, [user, ready, pathname, router])

  if (!ready) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg)',
      }}>
        <div style={{
          width: 28, height: 28,
          border: '2px solid var(--border-strong)',
          borderTopColor: 'var(--acc)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
      </div>
    )
  }

  return <>{children}</>
}
