import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../middleware/auth'
import { unauthorized } from '../utils/response'
import { providerConfigured } from '../utils/llm'

// Reports which LLM providers have an API key configured server-side, so the
// model picker can mark unconfigured providers and auto-select a working one.
// Returns booleans only — never the key values themselves.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  return NextResponse.json({
    claude: providerConfigured('claude'),
    gemini: providerConfigured('gemini'),
    openrouter: providerConfigured('openrouter'),
  })
}
