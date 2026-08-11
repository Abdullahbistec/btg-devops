import Anthropic from '@anthropic-ai/sdk'
import { MODEL_CATALOG, type LLMProvider } from '../../lib/modelCatalog'

// Provider-neutral LLM layer. Analysis/chat build the same message list
// regardless of provider; callLLM dispatches to the selected backend and
// returns the raw text. This keeps the Claude path intact while letting the
// dashboard run against free providers (Gemini, OpenRouter) for testing
// before an Anthropic key is available.

export type { LLMProvider }

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMCall {
  provider: LLMProvider
  model: string
  messages: LLMMessage[]
  maxTokens: number
}

/** Error tagged with the HTTP status the provider returned, so callers can
 *  tell a rate limit (429) apart from a genuine bad-request/auth failure. */
export class LLMCallError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'LLMCallError'
    this.status = status
  }
}

function isRetryable(err: unknown): boolean {
  const status = err instanceof LLMCallError ? err.status : (err as { status?: number } | undefined)?.status
  // 429 (rate limited) and 5xx (upstream having a bad day) are worth trying
  // a different model for. Anything else (400 bad request, 401/403 auth,
  // 404 unknown model) will fail identically on every other model too.
  return status === 429 || (typeof status === 'number' && status >= 500)
}

export function providerConfigured(provider: LLMProvider): boolean {
  const configured = (v?: string) => !!v && !v.startsWith('your-')
  if (provider === 'claude') return configured(process.env.ANTHROPIC_API_KEY)
  if (provider === 'gemini') return configured(process.env.GEMINI_API_KEY)
  return configured(process.env.OPENROUTER_API_KEY)
}

let anthropic: Anthropic | null = null
function claudeClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || key.startsWith('your-')) {
    throw new LLMCallError('ANTHROPIC_API_KEY is not configured', 401)
  }
  anthropic ??= new Anthropic({ apiKey: key })
  return anthropic
}

async function callClaude(model: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
  try {
    const response = await claudeClient().messages.create({ model, max_tokens: maxTokens, messages })
    const block = response.content.find(b => b.type === 'text')
    return block && block.type === 'text' ? block.text : ''
  } catch (e) {
    const status = (e as { status?: number } | undefined)?.status
    if (typeof status === 'number') {
      throw new LLMCallError(e instanceof Error ? e.message : 'Claude API error', status)
    }
    throw e
  }
}

async function callGemini(model: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new LLMCallError('GEMINI_API_KEY is not configured', 401)

  // Gemini uses "model" instead of "assistant" and nests text under parts[].
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } }),
    }
  )
  if (!res.ok) {
    throw new LLMCallError(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
  }
  const data = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts
  return Array.isArray(parts) ? parts.map((p: { text?: string }) => p.text || '').join('') : ''
}

async function callOpenRouter(model: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new LLMCallError('OPENROUTER_API_KEY is not configured', 401)

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      // Optional attribution headers OpenRouter recommends; harmless if unused.
      'X-Title': 'BTG DevOps Dashboard',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  })
  if (!res.ok) {
    throw new LLMCallError(`OpenRouter API error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
  }
  const data = await res.json()
  return data?.choices?.[0]?.message?.content || ''
}

export async function callLLM({ provider, model, messages, maxTokens }: LLMCall): Promise<string> {
  switch (provider) {
    case 'gemini':     return callGemini(model, messages, maxTokens)
    case 'openrouter': return callOpenRouter(model, messages, maxTokens)
    case 'claude':
    default:           return callClaude(model, messages, maxTokens)
  }
}

export interface LLMFallbackResult {
  text: string
  provider: LLMProvider
  model: string
  /** True if the requested model failed and a different one answered instead. */
  usedFallback: boolean
}

const MAX_ATTEMPTS = 4

/**
 * Calls the requested model; if it's rate-limited (429) or the upstream is
 * erroring (5xx), automatically tries other configured models from
 * MODEL_CATALOG instead of failing the whole request. Non-retryable errors
 * (bad request, auth, unknown model) fail immediately — trying every other
 * model wouldn't help.
 */
export async function callLLMWithFallback(
  primary: { provider: LLMProvider; model: string },
  messages: LLMMessage[],
  maxTokens: number
): Promise<LLMFallbackResult> {
  const seen = new Set([`${primary.provider}::${primary.model}`])
  const candidates: { provider: LLMProvider; model: string }[] = [primary]

  for (const entry of MODEL_CATALOG) {
    if (candidates.length >= MAX_ATTEMPTS) break
    const key = `${entry.provider}::${entry.model}`
    if (seen.has(key) || !providerConfigured(entry.provider)) continue
    seen.add(key)
    candidates.push({ provider: entry.provider, model: entry.model })
  }

  let lastError: unknown
  for (let i = 0; i < candidates.length; i++) {
    const { provider, model } = candidates[i]
    try {
      const text = await callLLM({ provider, model, messages, maxTokens })
      return { text, provider, model, usedFallback: i > 0 }
    } catch (e) {
      lastError = e
      if (!isRetryable(e)) throw e
      // else: fall through to the next candidate
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all LLM providers failed')
}
