'use client'

import { useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { MessageSquare, Lock, Send, Plus, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { ModelPicker } from '../lib/model'
import { buildScopeGroups, UsageTypeInfo } from '../lib/scopes'
import type { ChatMessage, ChatThread } from '../types'

const ALL_SCOPE = 'all'

const SUGGESTIONS = [
  'What is my biggest cost problem?',
  'Are there any security risks I should fix immediately?',
  'Which resources are unused or idle?',
  'What would you fix first in this subscription?',
]

/* minimal markdown: **bold** only */
function renderBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i} style={{ color: 'var(--t1)' }}>{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>
  )
}

interface ChatPanelProps {
  auditId: string
  resourceCounts?: Record<string, number>
  hasCost?: boolean
  usageTypes?: UsageTypeInfo[]
  /** 'card' = standalone glass card with capped height (default);
   *  'dock' = fills its container edge-to-edge (used inside ChatDock). */
  variant?: 'card' | 'dock'
}

export function ChatPanel({ auditId, resourceCounts = {}, hasCost = false, usageTypes = [], variant = 'card' }: ChatPanelProps) {
  const { user } = useAuth()
  const canChat = user?.role === 'admin' || user?.role === 'analyst'

  const scopeGroups = useMemo(
    () => buildScopeGroups(resourceCounts, hasCost, usageTypes),
    [resourceCounts, hasCost, usageTypes]
  )
  const [scope, setScope] = useState<string>(ALL_SCOPE)

  const searchParams = useSearchParams()
  // activeThreadId === null → a fresh, not-yet-saved conversation; the
  // backend creates the thread (titled from the question) on first send.
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput]       = useState('')
  const [sending, setSending]   = useState(false)
  const [error, setError]       = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const askSent   = useRef(false)

  // Load the conversation list; resume the most recent one by default —
  // unless arriving with a prefilled question (?ask=...), which starts its
  // own fresh conversation and must not be clobbered by auto-select.
  useEffect(() => {
    if (!canChat) return
    const hasAsk = !!searchParams.get('ask')
    api.listChatThreads(auditId)
      .then(list => {
        setThreads(list)
        if (list.length > 0 && !hasAsk) {
          setActiveThreadId(current => current ?? list[0].id)
        }
      })
      .catch(() => {})
  }, [auditId, canChat, searchParams])

  // Load messages whenever the active conversation changes. Clearing on
  // "no thread" happens in the event handlers (newChat/removeThread/select)
  // rather than here, per react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!canChat || !activeThreadId) return
    api.listChat(auditId, activeThreadId).then(setMessages).catch(() => {})
  }, [auditId, activeThreadId, canChat])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  const send = useCallback(async (text?: string, current?: string) => {
    const content = (text ?? current ?? '').trim()
    if (!content) return
    setInput('')
    setError('')
    setSending(true)

    setMessages(m => [...m, {
      id: `tmp-${m.length}`, audit_id: auditId, user_id: user?.id || '',
      role: 'user', content, created_at: '',
    }])

    try {
      const result = await api.sendChat(auditId, content, scope === ALL_SCOPE ? undefined : scope, activeThreadId || undefined)
      setMessages(m => [...m, {
        id: `tmp-a-${m.length}`, audit_id: auditId, user_id: '',
        role: 'assistant', content: result.reply, created_at: '',
        fallback_model: result.fallback_model,
      }])
      // First message of a fresh chat: the backend created the thread —
      // adopt it and refresh the list so its auto-title shows up.
      if (!activeThreadId) setActiveThreadId(result.thread_id)
      api.listChatThreads(auditId).then(setThreads).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Message failed')
    } finally {
      setSending(false)
    }
  }, [auditId, user?.id, scope, activeThreadId])

  function newChat() {
    setActiveThreadId(null)
    setMessages([])
    setError('')
  }

  async function removeThread() {
    if (!activeThreadId) return
    try {
      await api.deleteChatThread(auditId, activeThreadId)
      const rest = threads.filter(t => t.id !== activeThreadId)
      setThreads(rest)
      setActiveThreadId(rest[0]?.id || null)
      if (!rest[0]) setMessages([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  function switchThread(id: string | null) {
    setActiveThreadId(id)
    if (!id) setMessages([])
  }

  // prefilled question handoff (e.g. from the audit comparison page: ?ask=...)
  useEffect(() => {
    const ask = searchParams.get('ask')
    if (ask && canChat && !askSent.current) {
      askSent.current = true
      send(ask)
    }
  }, [searchParams, canChat, send])

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(undefined, input)
    }
  }

  const dock = variant === 'dock'

  return (
    <div
      className={dock ? undefined : 'glass'}
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        ...(dock ? {} : { minHeight: 420, maxHeight: 640 }),
      }}
    >
      {/* header — extra right padding in dock mode so the dock's X button doesn't overlap */}
      <div style={{ padding: dock ? '1rem 2.5rem 1rem 1.25rem' : '1rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <MessageSquare size={15} color="var(--acc)" style={{ alignSelf: 'center' }} />
          <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>Ask about this audit</h2>
          <div style={{ marginLeft: 'auto' }}>
            <ModelPicker />
          </div>
        </div>
        {scopeGroups.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>Ask about:</label>
            <select
              value={scope}
              onChange={e => setScope(e.target.value)}
              style={{
                background: 'var(--input-bg)', border: '1px solid var(--border-strong)',
                borderRadius: 8, color: 'var(--t2)', padding: '0.3rem 0.5rem', fontSize: '0.75rem', cursor: 'pointer', maxWidth: '100%',
              }}
            >
              <option value={ALL_SCOPE}>Everything in this audit</option>
              {scopeGroups.map(g => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}

        {/* conversation switcher — like a normal AI chat app */}
        {canChat && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <select
              value={activeThreadId || ''}
              onChange={e => switchThread(e.target.value || null)}
              disabled={sending}
              style={{
                flex: 1, minWidth: 0,
                background: 'var(--input-bg)', border: '1px solid var(--border-strong)',
                borderRadius: 8, color: 'var(--t2)', padding: '0.3rem 0.5rem', fontSize: '0.75rem', cursor: 'pointer',
              }}
            >
              {!activeThreadId && <option value="">New chat</option>}
              {threads.map(t => (
                <option key={t.id} value={t.id}>
                  {t.title}{t.message_count ? ` (${t.message_count})` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={newChat}
              disabled={sending || !activeThreadId}
              title="Start a new chat"
              style={{
                background: 'var(--input-bg)', border: '1px solid var(--border-strong)', borderRadius: 8,
                color: 'var(--t2)', padding: '0.3rem 0.45rem', cursor: 'pointer', display: 'flex',
                opacity: !activeThreadId ? 0.5 : 1,
              }}
            >
              <Plus size={14} />
            </button>
            <button
              onClick={removeThread}
              disabled={sending || !activeThreadId}
              title="Delete this chat"
              style={{
                background: 'var(--input-bg)', border: '1px solid var(--border-strong)', borderRadius: 8,
                color: '#ef4444', padding: '0.3rem 0.45rem', cursor: 'pointer', display: 'flex',
                opacity: !activeThreadId ? 0.5 : 1,
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      {!canChat ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--t3)', padding: '1.5rem' }}>
          <Lock size={22} style={{ marginBottom: '0.75rem' }} />
          <p style={{ fontSize: '0.82rem', textAlign: 'center' }}>Chat is available for analysts and admins only.</p>
        </div>
      ) : (
        <>
          {/* messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {messages.length === 0 && !sending && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--t4)', marginBottom: '0.25rem' }}>Try asking:</p>
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    style={{
                      textAlign: 'left', background: 'var(--input-bg)', border: '1px solid var(--border-strong)',
                      borderRadius: 8, padding: '0.55rem 0.75rem', fontSize: '0.78rem',
                      color: 'var(--t2)', cursor: 'pointer',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {messages.map(m => (
              <div
                key={m.id}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  background: m.role === 'user' ? 'var(--acc-soft)' : 'var(--input-bg)',
                  border: `1px solid ${m.role === 'user' ? 'rgba(96,165,250,0.25)' : 'var(--border)'}`,
                  borderRadius: 10,
                  padding: '0.6rem 0.8rem',
                  fontSize: '0.8rem',
                  color: 'var(--t2)',
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {m.role === 'assistant' ? renderBold(m.content) : m.content}
                {m.fallback_model && (
                  <div style={{ marginTop: '0.4rem', fontSize: '0.68rem', color: 'var(--t4)' }}>
                    Answered by {m.fallback_model} (your selected model was rate-limited)
                  </div>
                )}
              </div>
            ))}

            {sending && (
              <div style={{
                alignSelf: 'flex-start', background: 'var(--input-bg)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '0.7rem 0.9rem', display: 'flex', gap: 4,
              }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: 6, height: 6, borderRadius: '50%', background: 'var(--t3)',
                    animation: 'fadeIn 1s ease-in-out infinite alternate',
                    animationDelay: `${i * 0.2}s`,
                  }} />
                ))}
              </div>
            )}

            {error && <p style={{ fontSize: '0.75rem', color: '#ef4444' }}>{error}</p>}
            <div ref={bottomRef} />
          </div>

          {/* input */}
          <div style={{ display: 'flex', gap: '0.5rem', padding: '0.875rem 1.25rem', borderTop: '1px solid var(--border)' }}>
            <input
              className="field"
              placeholder="Ask a question about this audit…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={sending}
            />
            <button
              className="btn-primary"
              style={{ display: 'flex', alignItems: 'center', padding: '0.5rem 0.875rem' }}
              onClick={() => send(undefined, input)}
              disabled={sending || !input.trim()}
            >
              <Send size={15} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
