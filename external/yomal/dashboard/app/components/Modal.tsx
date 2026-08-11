'use client'

import { ReactNode } from 'react'
import { X, ShieldOff } from 'lucide-react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="glass animate-scale-in"
        style={{
          width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto',
          background: 'var(--panel)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>{title}</h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)', display: 'flex', padding: '0.25rem' }}
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: '1.25rem' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function AccessDenied({ message }: { message: string }) {
  return (
    <div style={{ padding: '4rem 1.5rem', textAlign: 'center' }}>
      <ShieldOff size={30} color="var(--t3)" style={{ margin: '0 auto 0.75rem', display: 'block' }} />
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--t1)', marginBottom: '0.375rem' }}>
        403 — Access Denied
      </h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--t3)' }}>{message}</p>
    </div>
  )
}
