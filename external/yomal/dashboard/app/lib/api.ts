const TOKEN_KEY = 'btg_token'
const MODEL_KEY = 'btg_model'

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}

// The model picker (lib/model.tsx) persists the selected provider/model here.
// api.ts reads it at call time so analyze/chat requests carry the choice
// without threading it through every component as props.
function getModelChoice(): { provider: string; model: string } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(MODEL_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  llmStatus: () =>
    apiFetch<{ claude: boolean; gemini: boolean; openrouter: boolean }>('/api/llm-status'),

  listAudits: () =>
    apiFetch<import('../types').Audit[]>('/api/audits'),

  listDataGaps: () =>
    apiFetch<{ open: import('../types').DataGapEntry[]; resolved: import('../types').ResolvedGapEntry[] }>('/api/data-gaps'),

  markDataGapFixed: (subscription_id: string, scope: string, note?: string) =>
    apiFetch<{ marked: boolean }>('/api/data-gaps', {
      method: 'POST',
      body: JSON.stringify({ subscription_id, scope, note }),
    }),

  triggerAudit: () =>
    apiFetch<{ triggered: boolean; triggered_at: string }>('/api/audits/trigger', { method: 'POST' }),

  getAnalysisProgress: (auditId: string) =>
    apiFetch<{
      total: number; done: number; pending: number; failed: number; cached: number
      scopes: { scope: string; status: 'pending' | 'done' | 'failed'; cache_hit: boolean }[]
    }>(`/api/audits/${auditId}/analysis-progress`),

  shareAnalysis: (auditId: string, scope: string, roles: string[], userIds: string[]) =>
    apiFetch<{ sent: boolean; recipientCount: number }>(`/api/audits/${auditId}/share`, {
      method: 'POST',
      body: JSON.stringify({ scope, roles, userIds }),
    }),

  getAudit: (id: string) =>
    apiFetch<import('../types').AuditDetail>(`/api/audits/${id}`),

  getCostSummary: (id: string) =>
    apiFetch<import('../types').CostSummary>(`/api/audits/${id}/cost-summary`),

  getUsageSummary: (id: string, type: string) =>
    apiFetch<import('../types').UsageSummary>(`/api/audits/${id}/usage-summary?type=${encodeURIComponent(type)}`),

  getResourceDetail: (id: string, resourceId: string) =>
    apiFetch<import('../types').ResourceDetail>(`/api/audits/${id}/resource-detail?resourceId=${encodeURIComponent(resourceId)}`),

  getResourceTypeSummary: (id: string, type: string) =>
    apiFetch<import('../types').ResourceTypeSummary>(`/api/audits/${id}/resource-type-summary?type=${encodeURIComponent(type)}`),

  getRegionSummary: (id: string) =>
    apiFetch<import('../types').RegionSummary>(`/api/audits/${id}/region-summary`),

  analyzeAudit: (id: string, resource?: string) => {
    const m = getModelChoice()
    const qs = new URLSearchParams()
    if (resource) qs.set('resource', resource)
    if (m) { qs.set('provider', m.provider); qs.set('model', m.model) }
    const query = qs.toString()
    return apiFetch<{ audit_id: string; resource: string | null; cached: boolean; analysis: Record<string, unknown> }>(
      `/api/audits/${id}/analysis${query ? `?${query}` : ''}`,
      { method: 'POST' }
    )
  },

  // Queues an analysis run for the scheduled Claude Code agent to pick up
  // (spec 8) instead of calling an LLM directly from this request.
  requestAnalysis: (auditId: string, scope: string) =>
    apiFetch<{ requestId: string; status: 'pending' | 'done' | 'failed'; cacheHit: boolean }>(
      `/api/audits/${auditId}/analysis-request`,
      { method: 'POST', body: JSON.stringify({ scope }) }
    ),

  getAnalysisRequest: (auditId: string, requestId: string) =>
    apiFetch<{
      requestId: string
      status: 'pending' | 'done' | 'failed'
      error_message?: string | null
      analysis?: Record<string, unknown>
      cacheHit: boolean
    }>(`/api/audits/${auditId}/analysis-request/${requestId}`),

  listFindings: (auditId: string, scope?: string) =>
    apiFetch<import('../types').Finding[]>(`/api/audits/${auditId}/findings${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),

  updateFinding: (auditId: string, findingId: string, data: { status?: string }) =>
    apiFetch<{ message: string }>(`/api/audits/${auditId}/findings/${findingId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  topFindings: (limit = 8) =>
    apiFetch<{ findings: import('../types').Finding[]; hasAnyFindings: boolean }>(`/api/findings/top?limit=${limit}`),

  savings: (subscriptionId?: string) =>
    apiFetch<{
      months: { month: string; total_saved_usd: number; findings_resolved: number }[]
      total_saved_usd: number
      total_findings_resolved: number
    }>(`/api/findings/savings${subscriptionId ? `?subscriptionId=${encodeURIComponent(subscriptionId)}` : ''}`),

  searchFindings: (q: string, limit = 8) =>
    apiFetch<{ findings: import('../types').Finding[] }>(`/api/findings/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  severityCounts: (auditIds: string[]) =>
    auditIds.length === 0
      ? Promise.resolve({} as Record<string, { critical: number; warning: number; info: number }>)
      : apiFetch<Record<string, { critical: number; warning: number; info: number }>>(
          `/api/findings/severity-counts?auditIds=${auditIds.map(encodeURIComponent).join(',')}`
        ),

  listChatThreads: (auditId: string) =>
    apiFetch<import('../types').ChatThread[]>(`/api/audits/${auditId}/chat/threads`),

  listChat: (auditId: string, threadId: string) =>
    apiFetch<import('../types').ChatMessage[]>(`/api/audits/${auditId}/chat/threads/${threadId}`),

  deleteChatThread: (auditId: string, threadId: string) =>
    apiFetch<{ message: string }>(`/api/audits/${auditId}/chat/threads/${threadId}`, { method: 'DELETE' }),

  // threadId omitted → the backend starts a new conversation (titled from
  // the question) and returns its id alongside the reply.
  sendChat: (auditId: string, content: string, scope?: string, threadId?: string) => {
    const m = getModelChoice()
    return apiFetch<{ reply: string; thread_id: string; fallback_model?: string }>(`/api/audits/${auditId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content, scope, thread_id: threadId, provider: m?.provider, model: m?.model }),
    })
  },

  getAuditResource: (auditId: string, slug: string) =>
    apiFetch<{ audit_id: string; resource: unknown; data: unknown }>(`/api/audits/${auditId}/resources/${slug}`),

  listSubscriptions: () =>
    apiFetch<import('../types').Subscription[]>('/api/subscriptions'),

  createSubscription: (data: unknown) =>
    apiFetch('/api/subscriptions', { method: 'POST', body: JSON.stringify(data) }),

  updateSubscription: (id: string, data: unknown) =>
    apiFetch(`/api/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteSubscription: (id: string) =>
    apiFetch(`/api/subscriptions/${id}`, { method: 'DELETE' }),

  listUsers: () =>
    apiFetch<import('../types').User[]>('/api/users'),

  createUser: (data: unknown) =>
    apiFetch('/api/users', { method: 'POST', body: JSON.stringify(data) }),

  updateUser: (id: string, data: unknown) =>
    apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteUser: (id: string) =>
    apiFetch(`/api/users/${id}`, { method: 'DELETE' }),

  listNotificationSettings: () =>
    apiFetch<{ role: 'admin' | 'analyst' | 'viewer'; enabled: boolean; updated_at: string }[]>('/api/notification-settings'),

  updateNotificationSetting: (role: string, enabled: boolean) =>
    apiFetch(`/api/notification-settings/${role}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
}
