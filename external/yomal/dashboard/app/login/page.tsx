'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../lib/auth'
import { ThemeToggle } from '../lib/theme'

export default function LoginPage() {
  const { login } = useAuth()
  const router    = useRouter()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const result = await login(email, password)
    setLoading(false)
    if (result.ok) {
      router.replace('/')
    } else {
      setError(result.error || 'Invalid email or password')
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
      backgroundImage: `
        radial-gradient(ellipse at 30% 40%, rgba(139,92,246,0.09) 0%, transparent 60%),
        radial-gradient(ellipse at 70% 70%, rgba(56,189,248,0.07) 0%, transparent 60%)
      `,
      padding: '1.5rem', position: 'relative',
    }}>
      <div style={{ position: 'absolute', top: '1rem', right: '1.5rem' }}>
        <ThemeToggle />
      </div>

      <div className="glass animate-scale-in" style={{ width: '100%', maxWidth: 400, padding: '2.5rem' }}>
        {/* logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12, margin: '0 auto 1rem',
            background: 'linear-gradient(135deg, #8B5CF6, #38BDF8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.8rem', fontWeight: 700, color: '#fff',
          }}>
            BTG
          </div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--t1)', marginBottom: '0.25rem' }}>
            BTG DevOps
          </h1>
          <p style={{ fontSize: '0.8rem', color: 'var(--t3)' }}>
            Azure Audit Console
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {error && (
            <div style={{
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: 8, padding: '0.625rem 0.875rem',
              fontSize: '0.875rem', color: '#ef4444',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--t2)' }}>Email</label>
            <input
              type="email"
              className="field"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@bistecglobal.com"
              required
              autoFocus
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--t2)' }}>Password</label>
            <input
              type="password"
              className="field"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={loading}
            style={{ width: '100%', marginTop: '0.5rem' }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
