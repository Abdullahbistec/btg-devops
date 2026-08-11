'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { MessageSquare, X } from 'lucide-react'
import { ChatPanel } from './ChatPanel'
import { useAuth } from '../lib/auth'
import { UsageTypeInfo } from '../lib/scopes'

const OPEN_KEY  = 'btg_chat_open'
const WIDTH_KEY = 'btg_chat_width'

const DEFAULT_WIDTH = 430
const MIN_WIDTH = 340
const MAX_WIDTH = 900

function clampWidth(w: number): number {
  const viewportMax = typeof window !== 'undefined' ? window.innerWidth * 0.9 : MAX_WIDTH
  return Math.round(Math.min(Math.min(MAX_WIDTH, viewportMax), Math.max(MIN_WIDTH, w)))
}

interface ChatDockProps {
  auditId: string
  resourceCounts?: Record<string, number>
  hasCost?: boolean
  usageTypes?: UsageTypeInfo[]
}

/**
 * Floating chat launcher + slide-in panel. Replaces the fixed right column
 * so the Analysis panel gets the full page width; the chat overlays content
 * only while open (no backdrop, so findings stay readable next to it).
 * The panel's left edge is draggable to resize; width persists across
 * sessions. Double-click the edge to reset to the default width.
 */
export function ChatDock(props: ChatDockProps) {
  const { user } = useAuth()
  const searchParams = useSearchParams()

  // Lazy initializers restore persisted state; ?ask=... (prefilled question
  // from the audit comparison page) forces the panel open so the auto-sent
  // message isn't answered invisibly. Guarded for SSR — though in practice
  // the server render returns null anyway (user is null until AuthProvider
  // hydrates), so there's no hydration mismatch.
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false
    return !!searchParams.get('ask') || localStorage.getItem(OPEN_KEY) === '1'
  })
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return saved ? clampWidth(saved) : DEFAULT_WIDTH
  })
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  function toggle(next: boolean) {
    setOpen(next)
    localStorage.setItem(OPEN_KEY, next ? '1' : '0')
  }

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') toggle(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragState.current = { startX: e.clientX, startWidth: width }
    setDragging(true)

    function onMove(ev: PointerEvent) {
      if (!dragState.current) return
      // Dragging left widens the panel (it's anchored to the right edge).
      const next = clampWidth(dragState.current.startWidth + (dragState.current.startX - ev.clientX))
      setWidth(next)
    }
    function onUp(ev: PointerEvent) {
      if (dragState.current) {
        const finalWidth = clampWidth(dragState.current.startWidth + (dragState.current.startX - ev.clientX))
        localStorage.setItem(WIDTH_KEY, String(finalWidth))
      }
      dragState.current = null
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [width])

  function resetWidth() {
    setWidth(DEFAULT_WIDTH)
    localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH))
  }

  if (!user) return null

  return (
    <>
      {/* floating launcher — hidden while the panel is open */}
      {!open && (
        <button
          onClick={() => toggle(true)}
          title="Ask about this audit"
          style={{
            position: 'fixed', right: '1.5rem', bottom: '1.5rem', zIndex: 90,
            width: 52, height: 52, borderRadius: '50%',
            background: 'var(--acc)', color: '#fff', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          }}
          className="animate-scale-in"
        >
          <MessageSquare size={22} />
        </button>
      )}

      {/* slide-in panel — no backdrop so the page stays readable behind it */}
      {open && (
        <div
          className="animate-scale-in"
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 90,
            width: `min(${width}px, 100vw)`,
            display: 'flex', flexDirection: 'column',
            background: 'var(--panel)',
            borderLeft: '1px solid var(--border-strong)',
            boxShadow: '-8px 0 32px rgba(0,0,0,0.35)',
            // Text selection fights the drag; disable it only while resizing.
            userSelect: dragging ? 'none' : undefined,
          }}
        >
          {/* resize handle — drag to resize, double-click to reset */}
          <div
            onPointerDown={startDrag}
            onDoubleClick={resetWidth}
            title="Drag to resize · double-click to reset"
            style={{
              position: 'absolute', top: 0, bottom: 0, left: -4, width: 9,
              cursor: 'col-resize', zIndex: 2,
            }}
          >
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: 4, width: 2,
              background: dragging ? 'var(--acc)' : 'transparent',
              transition: dragging ? 'none' : 'background 0.15s',
            }} />
          </div>

          <button
            onClick={() => toggle(false)}
            title="Close chat (Esc)"
            style={{
              position: 'absolute', top: '0.875rem', right: '1rem', zIndex: 1,
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--t3)', padding: '0.25rem', display: 'flex',
            }}
          >
            <X size={17} />
          </button>
          <ChatPanel {...props} variant="dock" />
        </div>
      )}
    </>
  )
}
