import { findAllAudits, findAuditById, findAuditResource, findAuditRawData, findAuditCostRaw, findAuditUsageRaw, updateClaudeAnalysis, insertAudit, updateAudit, deleteAudit, clearClaudeAnalysis, findAnalysisById } from '../models/audit'
import { findResourceBySlug } from '../models/resource'
import { insertAnalysisRequest, findLatestAnalysisRequest, findAnalysisRequestById, checkScopeCacheHit, isCostOrUsageScope, markAnalysisRequestDone } from '../models/analysisRequests'
import { runAnalysis, getAnalysisForScope } from '../utils/claude'
import { triggerAnalyzerRoutine } from '../utils/analyzerRoutine'
import { carryForwardCachedAnalysis } from '../utils/analysisCache'
import { LLMProvider } from '../utils/llm'
import { buildUsageGroups, listUsageTypes } from '../utils/usage'
import { computeRegionDistribution, computeCrossRegionMismatches } from '../utils/region'
import { CostSummary, UsageSummary, RegionSummary } from '../types'
import {
  detectZombieSpend, detectSpendSpikes, forecastCost,
  rollupCostByResourceGroup, rollupCostByTag, UTILIZATION_METRICS_BY_SLUG,
  resourceNameFromId, buildResourceInfoLookup, InventoryDataRaw,
} from '../utils/costInsights'
import { detectIdleResources } from '../utils/usageInsights'
import { resourceTypeSlug, summarizeMetric } from '../utils/usage'
import { findFindingsByAuditAndResource, findFindingsByAuditAndResourceType } from '../models/findings'
import { ResourceListEntry, ResourceDetail, ResourceTypeSummary, CostRow, UsageMetricRaw } from '../types'

// Coerce an untrusted provider string from the request into a valid provider,
// or undefined (which makes runAnalysis/runChat fall back to their default).
function coerceProvider(p?: string): LLMProvider | undefined {
  return p === 'claude' || p === 'gemini' || p === 'openrouter' ? p : undefined
}

function formatUsageDate(n: number): string {
  const s = String(n)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

const GITHUB_REPO = 'yomal321/btg-devops'
const GITHUB_WORKFLOW = 'scheduled-audit.yml'
const GITHUB_REF = 'production'

// Dispatches the same GitHub Actions workflow the daily cron uses, so a
// dashboard-triggered manual audit reuses the Go CLI's collection logic
// unchanged instead of duplicating it in TypeScript. Analysis requests get
// queued automatically once collect.go finishes (see collect.go); this
// endpoint only starts the audit, it doesn't wait for it.
export async function triggerAuditController() {
  const token = process.env.GITHUB_DISPATCH_TOKEN
  if (!token) {
    return { error: 'GITHUB_DISPATCH_TOKEN is not configured on the server', status: 500 }
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      // collect.go's --trigger flag only accepts 'manual' or 'scheduled' —
      // matches the audits.trigger_type CHECK constraint, no third value.
      body: JSON.stringify({ ref: GITHUB_REF, inputs: { trigger_label: 'manual' } }),
    }
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { error: `GitHub dispatch failed (${res.status}): ${body}`, status: 502 }
  }

  return { data: { triggered: true, triggered_at: new Date().toISOString() }, status: 202 }
}

// getCostSummaryController computes daily/service cost aggregates from
// cost_data (its own column — never touches the 12-resource-type raw_data
// blob) and lists which usage resource types have data, so the frontend can
// populate a type dropdown without fetching all usage data up front.
const SIGNAL_MAX_ZOMBIE_SPEND = 20
const SIGNAL_MAX_SPEND_SPIKES = 20
const SIGNAL_MAX_IDLE_RESOURCES = 30
const SIGNAL_MAX_ROLLUP_ROWS = 15
const SIGNAL_MAX_RESOURCES = 300

// Builds one row per distinct resource seen in cost rows or usage metrics,
// annotated with which of the already-computed signals (zombie/spike/idle)
// flag it — feeds the Cost & Usage page's resource picker. Sorted by cost
// desc so the highest-spend resources surface first in an unfiltered list.
function buildResourceList(
  costRows: CostRow[],
  usageMetrics: UsageMetricRaw[],
  signals: {
    zombieSpend: { resource_id: string }[]
    spendSpikes: { resource_id: string }[]
    idleResources: { resource_id: string }[]
  }
): ResourceListEntry[] {
  const zombieIds = new Set(signals.zombieSpend.map(f => f.resource_id))
  const spikeIds = new Set(signals.spendSpikes.map(f => f.resource_id))
  const idleIds = new Set(signals.idleResources.map(f => f.resource_id))

  const byId = new Map<string, { cost: number; hasUsage: boolean }>()
  for (const row of costRows) {
    if (!row.ResourceId) continue
    const entry = byId.get(row.ResourceId) || { cost: 0, hasUsage: false }
    entry.cost += row.Cost
    byId.set(row.ResourceId, entry)
  }
  for (const m of usageMetrics) {
    const entry = byId.get(m.resource_id) || { cost: 0, hasUsage: false }
    entry.hasUsage = true
    byId.set(m.resource_id, entry)
  }

  return Array.from(byId.entries())
    .map(([resourceId, { cost, hasUsage }]) => {
      const flags: ('zombie' | 'spike' | 'idle')[] = []
      if (zombieIds.has(resourceId)) flags.push('zombie')
      if (spikeIds.has(resourceId)) flags.push('spike')
      if (idleIds.has(resourceId)) flags.push('idle')
      return {
        resource_id: resourceId,
        resource_name: resourceNameFromId(resourceId),
        resource_type: resourceTypeSlug(resourceId),
        total_cost_usd: Math.round(cost * 100) / 100,
        has_usage: hasUsage,
        signals: flags,
      }
    })
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
}

export async function getCostSummaryController(auditId: string) {
  // cost_data, usage_data, and the inventory path of raw_data are independent
  // reads (findAuditResource does a targeted `raw_data -> 'inventory'`, not
  // the full 12-resource-type blob) — fetching them in parallel means total
  // wait is the slowest of the three, not the sum.
  const [raw, usage, inventory] = await Promise.all([
    findAuditCostRaw(auditId),
    findAuditUsageRaw(auditId),
    findAuditResource(auditId, 'inventory') as Promise<InventoryDataRaw | null>,
  ])
  if (!raw) return { error: 'audit not found', status: 404 }

  const actualRows = raw.cost?.actual_cost_rows || []
  const currency = actualRows[0]?.Currency || 'USD'

  const byDate = new Map<number, number>()
  const byService = new Map<string, number>()
  for (const row of actualRows) {
    byDate.set(row.UsageDate, (byDate.get(row.UsageDate) || 0) + row.Cost)
    const service = row.ServiceName || 'Unknown'
    byService.set(service, (byService.get(service) || 0) + row.Cost)
  }

  const dailyCost = Array.from(byDate.entries())
    .sort(([a], [b]) => a - b)
    .map(([date, cost]) => ({ date: formatUsageDate(date), cost: Math.round(cost * 100) / 100 }))

  const topServices = Array.from(byService.entries())
    .map(([service, cost]) => ({ service, cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)

  const usageTypes = listUsageTypes(usage?.metrics || [])

  // Same deterministic detectors buildPrecomputedSignals feeds to the LLM
  // (utils/claude.ts) — computed here too so the page can show them as
  // dedicated UI regardless of whether/when "Analyze" ran. Kept uncapped here
  // (matching the LLM path) so the resource list below can flag EVERY
  // affected resource, not just the top N shown in the signals cards; only
  // the `signals` field sent to the client is sliced.
  const zombieSpend = detectZombieSpend(actualRows, inventory)
  const spendSpikes = detectSpendSpikes(actualRows)
  const idleResources = detectIdleResources(usage?.metrics || [])

  const signals = {
    zombie_spend: zombieSpend.slice(0, SIGNAL_MAX_ZOMBIE_SPEND),
    spend_spikes: spendSpikes.slice(0, SIGNAL_MAX_SPEND_SPIKES),
    cost_forecast: forecastCost(actualRows),
    idle_resources: idleResources.slice(0, SIGNAL_MAX_IDLE_RESOURCES),
    cost_by_resource_group: rollupCostByResourceGroup(actualRows, inventory).slice(0, SIGNAL_MAX_ROLLUP_ROWS),
    cost_by_tag: rollupCostByTag(actualRows, inventory).slice(0, SIGNAL_MAX_ROLLUP_ROWS),
  }

  const resources = buildResourceList(actualRows, usage?.metrics || [], { zombieSpend, spendSpikes, idleResources })

  const summary: CostSummary = {
    currency,
    period_from: raw.cost?.period_from || '',
    period_to: raw.cost?.period_to || '',
    total_cost_rows: raw.cost?.total_rows || 0,
    daily_cost: dailyCost,
    top_services: topServices,
    signals,
    resources: resources.slice(0, SIGNAL_MAX_RESOURCES),
    resources_truncated: resources.length > SIGNAL_MAX_RESOURCES,
    total_resources_sampled: usage?.total_resources_sampled || 0,
    usage_types: usageTypes,
    claude_analysis: raw.claude_analysis,
  }

  return { data: summary, status: 200 }
}

// getResourceDetailController is getCostSummaryController's counterpart for
// ONE resource — same three column reads, same detector functions (run over
// the full audit so the zombie/spike/idle verdicts match what the
// all-resources view would show, then filtered down to this resource_id),
// plus the AI findings that mention it by name.
export async function getResourceDetailController(auditId: string, resourceId: string) {
  const [raw, usage, inventory] = await Promise.all([
    findAuditCostRaw(auditId),
    findAuditUsageRaw(auditId),
    findAuditResource(auditId, 'inventory') as Promise<InventoryDataRaw | null>,
  ])
  if (!raw) return { error: 'audit not found', status: 404 }

  const actualRows = raw.cost?.actual_cost_rows || []
  const currency = actualRows[0]?.Currency || 'USD'
  const allMetrics = usage?.metrics || []

  const resourceRows = actualRows.filter(r => r.ResourceId === resourceId)
  const byDate = new Map<number, number>()
  for (const row of resourceRows) byDate.set(row.UsageDate, (byDate.get(row.UsageDate) || 0) + row.Cost)
  const dailyCost = Array.from(byDate.entries())
    .sort(([a], [b]) => a - b)
    .map(([date, cost]) => ({ date: formatUsageDate(date), cost: Math.round(cost * 100) / 100 }))
  const totalCost = resourceRows.reduce((s, r) => s + r.Cost, 0)

  const usageMetrics = allMetrics
    .filter(m => m.resource_id === resourceId)
    .map(m => summarizeMetric(m))
    .map(({ metric_name, unit, avg, total }) => ({ metric_name, unit, avg, total }))

  const lookup = buildResourceInfoLookup(inventory)
  const resourceGroup = lookup?.get(resourceNameFromId(resourceId).toLowerCase())?.resourceGroup || null

  const detail: ResourceDetail = {
    resource_id: resourceId,
    resource_name: resourceNameFromId(resourceId),
    resource_type: resourceTypeSlug(resourceId),
    resource_group: resourceGroup,
    currency,
    daily_cost: dailyCost,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    avg_daily_cost_usd: dailyCost.length > 0 ? Math.round((totalCost / dailyCost.length) * 100) / 100 : 0,
    usage_metrics: usageMetrics,
    zombie: detectZombieSpend(actualRows, inventory).find(f => f.resource_id === resourceId) || null,
    spend_spikes: detectSpendSpikes(actualRows).filter(f => f.resource_id === resourceId),
    idle: detectIdleResources(allMetrics).filter(f => f.resource_id === resourceId),
    findings: await findFindingsByAuditAndResource(auditId, resourceNameFromId(resourceId)),
  }

  return { data: detail, status: 200 }
}

// getResourceTypeSummaryController is getResourceDetailController's
// counterpart for a whole resource TYPE — same three column reads and same
// detector functions, filtered by resourceTypeSlug instead of one
// resource_id, plus the individual resources of that type (for the
// resource-type page's "Individual" tab selector).
export async function getResourceTypeSummaryController(auditId: string, type: string) {
  const [raw, usage, inventory] = await Promise.all([
    findAuditCostRaw(auditId),
    findAuditUsageRaw(auditId),
    findAuditResource(auditId, 'inventory') as Promise<InventoryDataRaw | null>,
  ])
  if (!raw) return { error: 'audit not found', status: 404 }

  const actualRows = raw.cost?.actual_cost_rows || []
  const currency = actualRows[0]?.Currency || 'USD'
  const allMetrics = usage?.metrics || []

  const typeRows = actualRows.filter(r => r.ResourceId && resourceTypeSlug(r.ResourceId) === type)
  const typeMetrics = allMetrics.filter(m => resourceTypeSlug(m.resource_id) === type)

  const byDate = new Map<number, number>()
  for (const row of typeRows) byDate.set(row.UsageDate, (byDate.get(row.UsageDate) || 0) + row.Cost)
  const dailyCost = Array.from(byDate.entries())
    .sort(([a], [b]) => a - b)
    .map(([date, cost]) => ({ date: formatUsageDate(date), cost: Math.round(cost * 100) / 100 }))
  const totalCost = typeRows.reduce((s, r) => s + r.Cost, 0)

  const resourceIds = new Set<string>()
  typeRows.forEach(r => r.ResourceId && resourceIds.add(r.ResourceId))
  typeMetrics.forEach(m => resourceIds.add(m.resource_id))

  const utilizationMetricNames = UTILIZATION_METRICS_BY_SLUG[type]
  let avgUtilization: number | null = null
  if (utilizationMetricNames) {
    const values = typeMetrics
      .filter(m => utilizationMetricNames.includes(m.metric_name))
      .map(m => summarizeMetric(m).avg)
      .filter((v): v is number => v !== null)
    avgUtilization = values.length > 0 ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100 : null
  }

  const zombieIds = new Set(detectZombieSpend(actualRows, inventory).filter(f => resourceTypeSlug(f.resource_id) === type).map(f => f.resource_id))
  const spikeIds = new Set(detectSpendSpikes(actualRows).filter(f => resourceTypeSlug(f.resource_id) === type).map(f => f.resource_id))
  const idleIds = new Set(detectIdleResources(allMetrics).filter(f => resourceTypeSlug(f.resource_id) === type).map(f => f.resource_id))
  const flaggedCount = new Set([...zombieIds, ...spikeIds, ...idleIds]).size

  const resourceCostById = new Map<string, number>()
  for (const row of typeRows) resourceCostById.set(row.ResourceId, (resourceCostById.get(row.ResourceId) || 0) + row.Cost)

  const resources: ResourceListEntry[] = Array.from(resourceIds).map(id => {
    const flags: ('zombie' | 'spike' | 'idle')[] = []
    if (zombieIds.has(id)) flags.push('zombie')
    if (spikeIds.has(id)) flags.push('spike')
    if (idleIds.has(id)) flags.push('idle')
    return {
      resource_id: id,
      resource_name: resourceNameFromId(id),
      resource_type: type,
      total_cost_usd: Math.round((resourceCostById.get(id) || 0) * 100) / 100,
      has_usage: typeMetrics.some(m => m.resource_id === id),
      signals: flags,
    }
  }).sort((a, b) => b.total_cost_usd - a.total_cost_usd)

  const summary: ResourceTypeSummary = {
    resource_type: type,
    currency,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    resource_count: resourceIds.size,
    flagged_count: flaggedCount,
    avg_utilization_pct: avgUtilization,
    daily_cost: dailyCost,
    findings: await findFindingsByAuditAndResourceType(auditId, type),
    resources,
  }

  return { data: summary, status: 200 }
}

// getUsageSummaryController aggregates utilization data for ONE resource
// type only, computed on demand — the frontend calls this after the user
// picks a type from the dropdown, instead of loading all resource types'
// usage data up front.
export async function getUsageSummaryController(auditId: string, type: string) {
  const usage = await findAuditUsageRaw(auditId)
  if (!usage) return { error: 'no usage data for this audit', status: 404 }

  const summary: UsageSummary = { type, groups: buildUsageGroups(usage.metrics || [], type) }
  return { data: summary, status: 200 }
}

// getRegionSummaryController computes region distribution and cross-region
// compute/data mismatches from raw_data alone (its own column read — never
// touches cost_data/usage_data). Deterministic, no LLM call.
export async function getRegionSummaryController(auditId: string) {
  const rawData = await findAuditRawData(auditId)
  if (!rawData) return { error: 'audit not found or has no resource data', status: 404 }

  const summary: RegionSummary = {
    distribution: computeRegionDistribution(rawData),
    mismatches: computeCrossRegionMismatches(rawData),
  }
  return { data: summary, status: 200 }
}

export async function runAnalysisController(auditId: string, resourceSlug?: string, provider?: string, model?: string) {
  try {
    const result = await runAnalysis(auditId, resourceSlug, coerceProvider(provider), model || undefined)
    if (result.error) return { error: result.error, status: result.status }
    return {
      data: { audit_id: auditId, resource: resourceSlug || null, cached: result.cached, analysis: result.analysis },
      status: 200,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'analysis failed'
    return { error: message, status: 500 }
  }
}

// Enqueues an analysis run instead of calling an LLM directly (spec 8) — a
// scheduled Claude Code agent claims the pending row through the MCP server
// and writes the result back via saveAnalysisResult/getAnalysisForScope, the
// same functions runAnalysis itself uses for the (still-supported)
// synchronous path.
export async function createAnalysisRequestController(auditId: string, scope: string) {
  const audit = await findAuditById(auditId)
  if (!audit) return { error: 'audit not found', status: 404 }

  // Reuse an already-pending request for this exact scope rather than
  // enqueueing a duplicate — e.g. a double-click or a re-mounted poll.
  //
  // Still fire the routine trigger even on this reuse path: a click here is
  // an explicit "run this now" from the user, and the row could have been
  // sitting pending from BEFORE ROUTINE_TRIGGER_TOKEN was ever configured
  // (or from an automated queue that never had a chance to wake anything) —
  // in either case, an explicit click should always try to wake it, not
  // silently rely on whatever already happened when the row was inserted.
  const latest = await findLatestAnalysisRequest(auditId, scope)
  if (latest && latest.status === 'pending') {
    void triggerAnalyzerRoutine()
    return { data: { requestId: latest.id, status: latest.status, cacheHit: latest.cache_hit }, status: 200 }
  }

  // "all"/cost/usage scopes never have a scope_hashes entry (by design —
  // see spec 14), so skip the cache check for them rather than spend a
  // query that can only ever come back false.
  const cacheHit = scope !== 'all' && !isCostOrUsageScope(scope)
    ? await checkScopeCacheHit(auditId, scope)
    : false

  const request = await insertAnalysisRequest(auditId, scope, cacheHit)

  // A cache hit can be resolved right here, synchronously — no need to wait
  // for the scheduled agent to poll (spec 14). Falls through to the normal
  // pending/trigger path if carry-forward can't find a usable prior
  // analysis (defensive; shouldn't happen if cacheHit was computed correctly).
  if (cacheHit) {
    if (await carryForwardCachedAnalysis(auditId, scope)) {
      await markAnalysisRequestDone(request.id)
      return { data: { requestId: request.id, status: 'done', cacheHit: true }, status: 201 }
    }
  }

  // Best-effort: wakes the scheduled agent immediately instead of leaving a
  // manually-queued request to sit until its next daily cron tick (see
  // analyzerRoutine.ts) — never blocks the response on this.
  void triggerAnalyzerRoutine()
  return { data: { requestId: request.id, status: request.status, cacheHit: false }, status: 201 }
}

export async function getAnalysisRequestController(auditId: string, requestId: string) {
  const request = await findAnalysisRequestById(requestId)
  if (!request || request.audit_id !== auditId) return { error: 'analysis request not found', status: 404 }

  if (request.status !== 'done') {
    return {
      data: { requestId: request.id, status: request.status, error_message: request.error_message, cacheHit: request.cache_hit },
      status: 200,
    }
  }

  const analysis = await getAnalysisForScope(auditId, request.scope)
  return { data: { requestId: request.id, status: request.status, analysis, cacheHit: request.cache_hit }, status: 200 }
}

export async function listAuditsController() {
  const audits = await findAllAudits()
  return { data: audits, status: 200 }
}

export async function getAuditController(auditId: string, resourceSlug?: string | null) {
  if (resourceSlug) {
    const resource = await findResourceBySlug(resourceSlug)
    if (!resource) {
      return { error: 'unknown resource type: ' + resourceSlug, status: 404 }
    }
    const data = await findAuditResource(auditId, resourceSlug)
    if (!data) {
      return { error: 'no data for this resource in audit', status: 404 }
    }
    return { data: { audit_id: auditId, resource, data }, status: 200 }
  }

  const audit = await findAuditById(auditId)
  if (!audit) return { error: 'audit not found', status: 404 }

  // usage_types lets the frontend build a per-resource-type scope dropdown
  // (Analyze, Chat) without fetching all usage data up front.
  let usageTypes: ReturnType<typeof listUsageTypes> = []
  if (audit.has_usage) {
    const usage = await findAuditUsageRaw(auditId)
    usageTypes = listUsageTypes(usage?.metrics || [])
  }

  return { data: { ...audit, usage_types: usageTypes }, status: 200 }
}

export async function saveAnalysisController(auditId: string, body: object) {
  await updateClaudeAnalysis(auditId, body)
  return { data: { message: 'analysis saved' }, status: 200 }
}

export async function createAuditController(body: { subscription_id: string; subscription_name: string; trigger_type: string }) {
  const { subscription_id, subscription_name, trigger_type } = body
  if (!subscription_id || !trigger_type) {
    return { error: 'subscription_id and trigger_type required', status: 400 }
  }
  if (!['manual', 'scheduled'].includes(trigger_type)) {
    return { error: 'trigger_type must be manual or scheduled', status: 400 }
  }
  const id = await insertAudit(subscription_id, subscription_name || '', trigger_type)
  return { data: { id }, status: 201 }
}

export async function updateAuditController(
  auditId: string,
  body: { status?: string; error_message?: string; subscription_name?: string }
) {
  const validStatuses = ['running', 'completed', 'failed']
  if (body.status && !validStatuses.includes(body.status)) {
    return { error: 'status must be running, completed, or failed', status: 400 }
  }
  const updated = await updateAudit(auditId, body)
  if (!updated) return { error: 'audit not found or no fields to update', status: 404 }
  return { data: { message: 'updated' }, status: 200 }
}

export async function deleteAuditController(auditId: string) {
  const deleted = await deleteAudit(auditId)
  if (!deleted) return { error: 'audit not found', status: 404 }
  return { data: { message: 'deleted' }, status: 200 }
}

export async function getAnalysisController(auditId: string) {
  const audit = await findAuditById(auditId)
  if (!audit) return { error: 'audit not found', status: 404 }
  const analysis = await findAnalysisById(auditId)
  if (!analysis) return { error: 'no analysis for this audit', status: 404 }
  return { data: { audit_id: auditId, analysis }, status: 200 }
}

export async function deleteAnalysisController(auditId: string) {
  const cleared = await clearClaudeAnalysis(auditId)
  if (!cleared) return { error: 'audit not found', status: 404 }
  return { data: { message: 'analysis cleared' }, status: 200 }
}
