'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { api } from './api'
import { MODEL_CATALOG, type LLMProvider, type ModelChoice } from './modelCatalog'

export type { LLMProvider, ModelChoice }
export { MODEL_CATALOG }

const DEFAULT_CHOICE: ModelChoice = { provider: MODEL_CATALOG[0].provider, model: MODEL_CATALOG[0].model }
const STORAGE_KEY = 'btg_model'

type Availability = Record<LLMProvider, boolean>

interface ModelCtx {
  choice: ModelChoice
  setChoice: (c: ModelChoice) => void
  available: Availability
}

const ModelContext = createContext<ModelCtx>({
  choice: DEFAULT_CHOICE,
  setChoice: () => {},
  available: { claude: false, gemini: false, openrouter: false },
})

export function ModelProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ModelChoice>(DEFAULT_CHOICE)
  const [available, setAvailable] = useState<Availability>({ claude: false, gemini: false, openrouter: false })

  useEffect(() => {
    let saved: ModelChoice | null = null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) saved = JSON.parse(raw)
    } catch { /* ignore malformed */ }
    if (saved) setChoiceState(saved)

    // Discover which providers actually have a key, then auto-switch to a
    // configured one if the current/saved choice's provider has no key —
    // so the user isn't stuck on a provider that will always error.
    api.llmStatus()
      .then(status => {
        setAvailable(status)
        const current = saved || DEFAULT_CHOICE
        if (!status[current.provider]) {
          const firstAvailable = MODEL_CATALOG.find(m => status[m.provider])
          if (firstAvailable) {
            const next = { provider: firstAvailable.provider, model: firstAvailable.model }
            setChoiceState(next)
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
          }
        }
      })
      .catch(() => { /* not logged in yet, or endpoint unavailable — leave defaults */ })
  }, [])

  function setChoice(c: ModelChoice) {
    setChoiceState(c)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  }

  return <ModelContext.Provider value={{ choice, setChoice, available }}>{children}</ModelContext.Provider>
}

export function useModel() {
  return useContext(ModelContext)
}

export function ModelPicker() {
  const { choice, setChoice, available } = useModel()
  const value = `${choice.provider}::${choice.model}`
  const anyConfigured = Object.values(available).some(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'flex-end' }}>
      <select
        value={value}
        onChange={e => {
          const entry = MODEL_CATALOG.find(m => `${m.provider}::${m.model}` === e.target.value)
          if (entry) setChoice({ provider: entry.provider, model: entry.model })
        }}
        title="AI model used for Analyze and Chat"
        style={{
          background: 'var(--input-bg)', border: '1px solid var(--border-strong)',
          borderRadius: 8, color: 'var(--t2)', padding: '0.35rem 0.5rem',
          fontSize: '0.75rem', cursor: 'pointer', maxWidth: 240,
        }}
      >
        {MODEL_CATALOG.map(m => (
          <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
            {m.label}{available[m.provider] ? '' : ' — no key'}
          </option>
        ))}
      </select>
      {!anyConfigured && (
        <span style={{ fontSize: '0.62rem', color: '#fbbf24' }}>
          No API key set — add GEMINI_API_KEY to .env.local
        </span>
      )}
    </div>
  )
}
