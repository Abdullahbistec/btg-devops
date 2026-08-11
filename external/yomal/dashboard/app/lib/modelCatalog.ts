// Plain data — no 'use client', so this is safe to import from server code
// (API routes) as well as the client-side model picker.

export type LLMProvider = 'claude' | 'gemini' | 'openrouter'

export interface ModelChoice {
  provider: LLMProvider
  model: string
}

export interface CatalogEntry extends ModelChoice {
  label: string
}

// Editable catalog of selectable models. Free providers (Gemini, OpenRouter)
// are listed for testing before an Anthropic key is available; Claude is the
// production target. Model IDs can be adjusted as providers change theirs.
// OpenRouter's free-tier lineup changes over time — verified live against
// https://openrouter.ai/api/v1/models (filter: pricing.prompt === "0") on
// 2026-07-04. If a free model here starts 404ing as "moved to paid", re-check
// that endpoint rather than guessing a replacement slug.
//
// Order also doubles as the 429 fallback chain (see api/utils/llm.ts) — each
// OpenRouter entry is deliberately a different upstream vendor, so if one
// backend is congested, the next entry is likely still available.
export const MODEL_CATALOG: CatalogEntry[] = [
  { provider: 'gemini',     model: 'gemini-2.0-flash',                          label: 'Gemini 2.0 Flash (free)' },
  { provider: 'gemini',     model: 'gemini-1.5-flash',                          label: 'Gemini 1.5 Flash (free)' },
  { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free',              label: 'Llama 3.3 70B (OpenRouter, free)' },
  { provider: 'openrouter', model: 'meta-llama/llama-3.2-3b-instruct:free',               label: 'Llama 3.2 3B (OpenRouter, free)' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b:free',                            label: 'GPT-OSS 120B (OpenRouter, free)' },
  { provider: 'openrouter', model: 'openai/gpt-oss-20b:free',                             label: 'GPT-OSS 20B (OpenRouter, free)' },
  { provider: 'openrouter', model: 'qwen/qwen3-coder:free',                               label: 'Qwen3 Coder 480B (OpenRouter, free)' },
  { provider: 'openrouter', model: 'qwen/qwen3-next-80b-a3b-instruct:free',               label: 'Qwen3 Next 80B (OpenRouter, free)' },
  { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free',              label: 'Nemotron 3 Super 120B (OpenRouter, free)' },
  { provider: 'openrouter', model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', label: 'Dolphin Mistral 24B (OpenRouter, free)' },
  { provider: 'claude',     model: 'claude-sonnet-4-6',                         label: 'Claude Sonnet 4.6' },
]

export function catalogLabel(provider: LLMProvider, model: string): string {
  return MODEL_CATALOG.find(m => m.provider === provider && m.model === model)?.label || model
}
