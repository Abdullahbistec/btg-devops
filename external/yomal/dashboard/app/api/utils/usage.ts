import { UsageMetricRaw } from '../types'

// Maps an ARM resource type (as embedded in the resource ID) to the same
// slug used elsewhere in the dashboard (icons, labels). Usage metrics only
// carry the full resource ID, not a clean type field, so the slug is
// recovered by parsing the ID's /providers/{Namespace}/{Type}/ segment.
const ARM_TYPE_TO_SLUG: Record<string, string> = {
  'microsoft.documentdb/databaseaccounts': 'cosmosdb',
  'microsoft.storage/storageaccounts': 'storage',
  'microsoft.web/serverfarms': 'appserviceplan',
  'microsoft.web/sites': 'appservice',
  'microsoft.keyvault/vaults': 'keyvault',
  'microsoft.containerregistry/registries': 'acr',
  'microsoft.network/publicipaddresses': 'publicip',
  'microsoft.cognitiveservices/accounts': 'cognitiveservices',
}

export function resourceTypeSlug(resourceId: string): string | null {
  const match = resourceId.match(/\/providers\/([^/]+)\/([^/]+)\//i)
  if (!match) return null
  return ARM_TYPE_TO_SLUG[`${match[1].toLowerCase()}/${match[2].toLowerCase()}`] || null
}

export function summarizeMetric(m: UsageMetricRaw) {
  // The CLI pre-computes this at collection time (see extractors/usage.go)
  // so reading it here is just a field lookup, not a re-scan of every
  // datapoint on every page load. Fall back to computing it for audits
  // collected before that field existed.
  let avg: number | null
  let total: number | null
  if (m.summary) {
    avg = m.summary.avg
    total = m.summary.total
  } else {
    const points = m.data_points || []
    const avgPoints = points.filter(p => p.average !== undefined)
    const totalPoints = points.filter(p => p.total !== undefined)
    avg = avgPoints.length ? avgPoints.reduce((s, p) => s + (p.average || 0), 0) / avgPoints.length : null
    total = totalPoints.length ? totalPoints.reduce((s, p) => s + (p.total || 0), 0) : null
  }
  return { metric_name: m.metric_name, unit: m.unit, avg, total, rank: total ?? avg ?? 0 }
}

export interface UsageGroup {
  resource_id: string
  metrics: { metric_name: string; unit: string; avg: number | null; total: number | null }[]
}

// Groups usage metrics for ONE resource type, sorted by activity — shared by
// the usage-summary endpoint (UI table) and the "usage:<type>" analyze/chat
// scope (LLM context), so both see identical numbers.
export function buildUsageGroups(metrics: UsageMetricRaw[], type: string): UsageGroup[] {
  const byResource = new Map<string, ReturnType<typeof summarizeMetric>[]>()
  for (const m of metrics) {
    if (resourceTypeSlug(m.resource_id) !== type) continue
    const list = byResource.get(m.resource_id) || []
    list.push(summarizeMetric(m))
    byResource.set(m.resource_id, list)
  }

  return Array.from(byResource.entries())
    .map(([resource_id, list]) => ({
      resource_id,
      rank: Math.max(0, ...list.map(m => m.rank)),
      metrics: list.map(m => ({ metric_name: m.metric_name, unit: m.unit, avg: m.avg, total: m.total })),
    }))
    .sort((a, b) => b.rank - a.rank)
    .map(({ resource_id, metrics }) => ({ resource_id, metrics }))
}

export interface UsageTypeInfo { slug: string; count: number }

// Lists which resource types have usage data and how many resources each —
// used to populate scope dropdowns (Analyze, Chat, Resource Utilization)
// without loading all usage data up front.
export function listUsageTypes(metrics: UsageMetricRaw[]): UsageTypeInfo[] {
  const resourcesByType = new Map<string, Set<string>>()
  for (const m of metrics) {
    const slug = resourceTypeSlug(m.resource_id)
    if (!slug) continue
    const set = resourcesByType.get(slug) || new Set<string>()
    set.add(m.resource_id)
    resourcesByType.set(slug, set)
  }
  return Array.from(resourcesByType.entries())
    .map(([slug, ids]) => ({ slug, count: ids.size }))
    .sort((a, b) => b.count - a.count)
}
