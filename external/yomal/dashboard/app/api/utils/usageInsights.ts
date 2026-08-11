import { UsageMetricRaw } from '../types'
import { resourceTypeSlug, summarizeMetric } from './usage'

export interface IdleResourceFinding {
  resource_id: string
  resource_name: string
  resource_type: string // dashboard slug, e.g. "cosmosdb", "storage"
  metric_name: string
  avg: number | null
  total: number | null
  reason: string
}

// Per-slug idle/over-provisioning rules. Each rule flags a metric whose
// value is at or below a threshold that indicates the resource is doing
// essentially nothing (or, for percentage metrics, using a small fraction
// of what it's provisioned for). Thresholds are deliberately conservative —
// aimed at "clearly not doing anything," not "could maybe be a bit smaller."
//
// NOTE: this only ever compares usage against ITS OWN metric — there is no
// cross-reference against provisioned capacity (e.g. Cosmos DB RU/s, App
// Service Plan SKU size) here, because that config is not present in
// collected data. Cosmos DB throughput specifically lives on the
// database/container sub-resource (armcosmos SQLResourcesClient), which
// ExtractCosmosDB never fetches — only the account envelope. NormalizedRUConsumption
// (already a 0-100 utilization percentage Azure computes against whatever is
// provisioned) is used as the stand-in for "provisioned vs. used" instead.
const IDLE_RULES: Record<string, { metric: string; maxAvg?: number; maxTotal?: number; reason: string }[]> = {
  cosmosdb: [
    { metric: 'NormalizedRUConsumption', maxAvg: 10, reason: 'Provisioned RU/s utilization under 10% over the period — likely over-provisioned throughput' },
    { metric: 'TotalRequestUnits', maxTotal: 0, reason: 'Zero request units consumed over the period — account appears fully idle' },
  ],
  appserviceplan: [
    { metric: 'CpuPercentage', maxAvg: 5, reason: 'Average CPU under 5% over the period — plan is likely over-sized for its workload' },
    { metric: 'MemoryPercentage', maxAvg: 5, reason: 'Average memory under 5% over the period — plan is likely over-sized for its workload' },
  ],
  appservice: [
    { metric: 'Requests', maxTotal: 0, reason: 'Zero requests over the period — app appears unused' },
  ],
  storage: [
    { metric: 'Transactions', maxTotal: 0, reason: 'Zero transactions over the period — storage account appears unused' },
  ],
  keyvault: [
    { metric: 'ServiceApiHit', maxTotal: 0, reason: 'Zero API hits over the period — vault appears unused' },
  ],
  acr: [
    { metric: 'TotalPullCount', maxTotal: 0, reason: 'Zero image pulls over the period — registry appears unused' },
    { metric: 'TotalPushCount', maxTotal: 0, reason: 'Zero image pushes over the period — registry appears unused' },
  ],
  cognitiveservices: [
    { metric: 'TotalCalls', maxTotal: 0, reason: 'Zero API calls over the period — account appears unused' },
  ],
  // publicip intentionally omitted — its sampled metrics (BytesInDDoS/
  // PacketsInDDoS) describe DDoS protection activity, not general traffic,
  // so a low value there says nothing about whether the IP itself is idle.
}

function resourceNameFromId(resourceId: string): string {
  const parts = resourceId.split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

// Flags resources whose own Azure Monitor metrics show near-zero activity —
// pure threshold checks over data already collected, no LLM judgment
// involved (see IDLE_RULES above for what's actually being compared and why).
export function detectIdleResources(metrics: UsageMetricRaw[]): IdleResourceFinding[] {
  const findings: IdleResourceFinding[] = []

  for (const m of metrics) {
    const slug = resourceTypeSlug(m.resource_id)
    if (!slug) continue
    const rules = IDLE_RULES[slug]
    if (!rules) continue

    const rule = rules.find(r => r.metric === m.metric_name)
    if (!rule) continue

    const { avg, total } = summarizeMetric(m)
    const avgOk = rule.maxAvg === undefined || (avg !== null && avg <= rule.maxAvg)
    const totalOk = rule.maxTotal === undefined || (total !== null && total <= rule.maxTotal)
    // Both thresholds present on a rule must each hold; a rule normally only
    // sets one of the two, so in practice this checks whichever was set.
    if (!avgOk || !totalOk) continue
    if (rule.maxAvg === undefined && rule.maxTotal === undefined) continue

    findings.push({
      resource_id: m.resource_id,
      resource_name: resourceNameFromId(m.resource_id),
      resource_type: slug,
      metric_name: m.metric_name,
      avg,
      total,
      reason: rule.reason,
    })
  }

  return findings
}

export interface UsagePeriodDelta {
  resource_id: string
  resource_name: string
  metric_name: string
  current_avg: number | null
  previous_avg: number | null
  delta: number | null
}

const USAGE_DELTA_MIN_ABSOLUTE = 10 // percentage points (or metric-native units) — ignore small moves

// Compares this audit's per-resource/per-metric averages against the prior
// audit's, per resource+metric — e.g. "Cosmos DB RU consumption dropped from
// 40% to 6% since last audit," a real "since when" instead of a static
// snapshot. Pure arithmetic over two audits' stored metrics; no LLM
// involved. Returns [] when there is no prior audit's usage data to compare.
export function compareUsagePeriods(currentMetrics: UsageMetricRaw[], previousMetrics: UsageMetricRaw[] | null | undefined): UsagePeriodDelta[] {
  if (!previousMetrics || previousMetrics.length === 0) return []

  const key = (m: UsageMetricRaw) => `${m.resource_id}::${m.metric_name}`
  const currentByKey = new Map(currentMetrics.map(m => [key(m), m]))
  const previousByKey = new Map(previousMetrics.map(m => [key(m), m]))

  const deltas: UsagePeriodDelta[] = []
  for (const [k, curMetric] of currentByKey) {
    const prevMetric = previousByKey.get(k)
    if (!prevMetric) continue

    const curAvg = summarizeMetric(curMetric).avg
    const prevAvg = summarizeMetric(prevMetric).avg
    if (curAvg === null || prevAvg === null) continue

    const delta = curAvg - prevAvg
    if (Math.abs(delta) < USAGE_DELTA_MIN_ABSOLUTE) continue

    deltas.push({
      resource_id: curMetric.resource_id,
      resource_name: resourceNameFromId(curMetric.resource_id),
      metric_name: curMetric.metric_name,
      current_avg: Math.round(curAvg * 100) / 100,
      previous_avg: Math.round(prevAvg * 100) / 100,
      delta: Math.round(delta * 100) / 100,
    })
  }

  return deltas.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0))
}
