import { CostRow, UsageMetricRaw } from '../types'
import { resourceTypeSlug, summarizeMetric } from './usage'

// Mirrors CLI Engine/internal/extractors/inventory.go's InventoryResource/
// InventoryData JSON shape — the envelope-only listing of every resource in
// the subscription (name/type/resourceGroup/tags, no properties). This is
// the only place a resource's current existence can be checked against,
// since CleanResource() strips the ARM "id" field from every other
// extractor's output (cleaner.go) — cost rows are the one place a full ARM
// resource ID still survives.
export interface InventoryResource {
  name: string
  type: string
  location?: string
  resourceGroup?: string
  tags?: Record<string, string>
}

export interface InventoryDataRaw {
  total_resources: number
  by_type: Record<string, number>
  truncated?: boolean
  resources: InventoryResource[]
}

export interface ZombieSpendFinding {
  resource_name: string
  resource_id: string
  last_service_name: string
  total_cost_usd: number
  first_cost_date: string // YYYY-MM-DD
  last_cost_date: string // YYYY-MM-DD
  billed_days: number
}

// Recovers the resource name from a full ARM resource ID's last path
// segment (e.g. ".../storageAccounts/mystorage123" -> "mystorage123") —
// the same trailing segment ARM uses as the resource's `name` field, which
// is all InventoryResource retains for matching.
export function resourceNameFromId(resourceId: string): string {
  const parts = resourceId.split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

function formatUsageDate(d: number): string {
  const s = String(d)
  if (s.length !== 8) return s
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

// Finds cost rows for resources that no longer exist in the current audit's
// resource inventory — spend continuing to bill for something already
// deleted from the portal (a leftover disk, snapshot, or reserved IP tied to
// a resource that's gone). Pure set-difference over data already collected;
// no LLM judgment involved, so results are exact and reproducible.
//
// Matches by NAME, not ARM id, because CleanResource() strips "id" from
// every other extractor's output — a false positive is possible only if a
// deleted resource's exact name was reused by an unrelated resource
// elsewhere in the subscription, which is rare enough not to guard against.
//
// Returns [] (not partial results) when the inventory listing was truncated
// (CLI Engine/internal/extractors/inventory.go's 500-resource cap) — a
// "not found" there could just mean "past the cap," and reporting a resource
// as zombie spend when it might simply exist outside the captured list would
// be a false accusation, not a safe assumption.
export function detectZombieSpend(
  costRows: CostRow[],
  inventory: InventoryDataRaw | null | undefined
): ZombieSpendFinding[] {
  if (!inventory || inventory.truncated) return []

  const knownNames = new Set(inventory.resources.map(r => r.name.toLowerCase()))

  const byResource = new Map<string, { serviceName: string; cost: number; minDate: number; maxDate: number }>()
  for (const row of costRows) {
    if (!row.ResourceId) continue
    const name = resourceNameFromId(row.ResourceId).toLowerCase()
    if (!name || knownNames.has(name)) continue

    const existing = byResource.get(row.ResourceId)
    if (existing) {
      existing.cost += row.Cost
      existing.serviceName = row.ServiceName || existing.serviceName
      existing.minDate = Math.min(existing.minDate, row.UsageDate)
      existing.maxDate = Math.max(existing.maxDate, row.UsageDate)
    } else {
      byResource.set(row.ResourceId, {
        serviceName: row.ServiceName || '',
        cost: row.Cost,
        minDate: row.UsageDate,
        maxDate: row.UsageDate,
      })
    }
  }

  return Array.from(byResource.entries())
    .map(([resourceId, v]) => ({
      resource_name: resourceNameFromId(resourceId),
      resource_id: resourceId,
      last_service_name: v.serviceName,
      total_cost_usd: Math.round(v.cost * 100) / 100,
      first_cost_date: formatUsageDate(v.minDate),
      last_cost_date: formatUsageDate(v.maxDate),
      billed_days: new Set(
        costRows.filter(r => r.ResourceId === resourceId).map(r => r.UsageDate)
      ).size,
    }))
    .filter(f => f.total_cost_usd > 0)
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
}

export interface SpendSpikeFinding {
  resource_name: string
  resource_id: string
  service_name: string
  spike_date: string // YYYY-MM-DD
  spike_amount_usd: number
  baseline_daily_avg_usd: number
  z_score: number | null // null when the baseline had zero variance (flat_baseline is set instead)
  flat_baseline: boolean
}

const SPIKE_Z_SCORE_THRESHOLD = 2.5
const SPIKE_MIN_ABSOLUTE_DELTA_USD = 5
const SPIKE_MIN_BILLED_DAYS = 14 // need enough history for mean/stddev to mean anything

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length
}

function stddev(values: number[], avg: number): number {
  return Math.sqrt(mean(values.map(v => (v - avg) ** 2)))
}

// Flags days where one resource's daily cost is a statistical outlier
// against its OWN 90-day history — a z-score (how many standard deviations
// a day sits from that resource's mean) instead of a fixed "3x average"
// rule, because a flat multiplier misfires on resources with naturally
// spiky daily cost (e.g. batch jobs) and under-reacts on resources that are
// normally dead flat. Every number here is arithmetic over ActualCostRows
// already collected — no LLM involved, so the same audit always produces
// the same spikes.
export function detectSpendSpikes(costRows: CostRow[]): SpendSpikeFinding[] {
  const byResource = new Map<string, { serviceName: string; byDate: Map<number, number> }>()
  for (const row of costRows) {
    if (!row.ResourceId) continue
    const entry = byResource.get(row.ResourceId) || { serviceName: row.ServiceName || '', byDate: new Map<number, number>() }
    entry.byDate.set(row.UsageDate, (entry.byDate.get(row.UsageDate) || 0) + row.Cost)
    entry.serviceName = row.ServiceName || entry.serviceName
    byResource.set(row.ResourceId, entry)
  }

  const findings: SpendSpikeFinding[] = []
  for (const [resourceId, { serviceName, byDate }] of byResource) {
    if (byDate.size < SPIKE_MIN_BILLED_DAYS) continue

    const dailyCosts = Array.from(byDate.values())
    const avg = mean(dailyCosts)
    const sd = stddev(dailyCosts, avg)

    for (const [date, cost] of byDate) {
      const delta = cost - avg
      if (delta < SPIKE_MIN_ABSOLUTE_DELTA_USD) continue

      if (sd > 0) {
        const z = delta / sd
        if (z >= SPIKE_Z_SCORE_THRESHOLD) {
          findings.push({
            resource_name: resourceNameFromId(resourceId),
            resource_id: resourceId,
            service_name: serviceName,
            spike_date: formatUsageDate(date),
            spike_amount_usd: Math.round(cost * 100) / 100,
            baseline_daily_avg_usd: Math.round(avg * 100) / 100,
            z_score: Math.round(z * 100) / 100,
            flat_baseline: false,
          })
        }
      } else if (cost > avg * 3) {
        // No variance in the baseline at all (identical cost every prior
        // day) — z-score is undefined/infinite, so fall back to an absolute
        // multiple for this case only.
        findings.push({
          resource_name: resourceNameFromId(resourceId),
          resource_id: resourceId,
          service_name: serviceName,
          spike_date: formatUsageDate(date),
          spike_amount_usd: Math.round(cost * 100) / 100,
          baseline_daily_avg_usd: Math.round(avg * 100) / 100,
          z_score: null,
          flat_baseline: true,
        })
      }
    }
  }

  return findings.sort((a, b) => b.spike_amount_usd - a.spike_amount_usd)
}

export interface ServiceConcentrationFinding {
  service_name: string
  total_cost_usd: number
  cost_share_pct: number
  resource_count: number
  resource_share_pct: number
  concentration_ratio: number // cost_share / resource_share — how much more a service costs than its resource count alone would suggest
}

const CONCENTRATION_MIN_COST_SHARE = 0.15 // ignore services that aren't a meaningfully large slice of total spend
const CONCENTRATION_MIN_RATIO = 2 // cost share at least 2x its resource-count share

// Flags a ServiceName whose share of total spend is disproportionate to its
// share of the resource count producing that spend — e.g. 5% of resources
// driving 40% of the bill, worth a reserved-instance/savings-plan look.
// Resource "count" and "share" here come straight from the distinct
// ResourceIds in the cost rows themselves (not the 12-resource-type
// extractors), since Azure's billing ServiceName values don't line up
// cleanly with those extractor slugs and cost data covers far more service
// types than the 12 have dedicated extractors for.
export function detectServiceConcentration(costRows: CostRow[]): ServiceConcentrationFinding[] {
  const byService = new Map<string, { cost: number; resourceIds: Set<string> }>()
  let totalCost = 0
  const allResourceIds = new Set<string>()

  for (const row of costRows) {
    if (!row.ServiceName) continue
    const entry = byService.get(row.ServiceName) || { cost: 0, resourceIds: new Set<string>() }
    entry.cost += row.Cost
    if (row.ResourceId) entry.resourceIds.add(row.ResourceId)
    byService.set(row.ServiceName, entry)
    totalCost += row.Cost
    if (row.ResourceId) allResourceIds.add(row.ResourceId)
  }

  if (totalCost <= 0 || allResourceIds.size === 0) return []

  const findings: ServiceConcentrationFinding[] = []
  for (const [serviceName, { cost, resourceIds }] of byService) {
    const costShare = cost / totalCost
    const resourceShare = resourceIds.size / allResourceIds.size
    if (costShare < CONCENTRATION_MIN_COST_SHARE || resourceShare <= 0) continue

    const ratio = costShare / resourceShare
    if (ratio < CONCENTRATION_MIN_RATIO) continue

    findings.push({
      service_name: serviceName,
      total_cost_usd: Math.round(cost * 100) / 100,
      cost_share_pct: Math.round(costShare * 1000) / 10,
      resource_count: resourceIds.size,
      resource_share_pct: Math.round(resourceShare * 1000) / 10,
      concentration_ratio: Math.round(ratio * 100) / 100,
    })
  }

  return findings.sort((a, b) => b.concentration_ratio - a.concentration_ratio)
}

export interface CostUsageWasteFinding {
  resource_id: string
  resource_name: string
  resource_type: string // dashboard slug
  total_cost_usd: number // summed over the cost data's period
  utilization_pct: number // the higher of the resource's relevant percentage metrics
  cost_per_utilization_point_usd: number
}

// Only resource types with a real 0-100 utilization metric are eligible —
// pairing a raw count (transactions, pulls, calls) with a dollar figure
// doesn't produce a meaningful "cost per utilization point" ratio the way a
// percentage does. Cosmos DB's NormalizedRUConsumption and App Service
// Plan's Cpu/MemoryPercentage are the only two metrics collected today that
// qualify (see usageInsights.ts's IDLE_RULES for the full metric set).
export const UTILIZATION_METRICS_BY_SLUG: Record<string, string[]> = {
  cosmosdb: ['NormalizedRUConsumption'],
  appserviceplan: ['CpuPercentage', 'MemoryPercentage'],
}

const WASTE_MIN_COST_USD = 20 // ignore resources too cheap to matter
const WASTE_MAX_UTILIZATION_PCT = 15

// Pairs each resource's total cost against its own utilization — the
// concrete "$X/month but Y% utilization" finding. Utilization uses the
// HIGHEST of a resource's relevant percentage metrics (e.g. max of CPU and
// memory for an App Service Plan), so a plan that's actually memory-bound
// isn't flagged just because CPU alone is low. Pure join + threshold over
// data already collected — no LLM judgment in the detection itself.
export function detectCostUsageWaste(costRows: CostRow[], usageMetrics: UsageMetricRaw[]): CostUsageWasteFinding[] {
  const costByResource = new Map<string, { cost: number; originalId: string }>()
  for (const row of costRows) {
    if (!row.ResourceId) continue
    const key = row.ResourceId.toLowerCase()
    const existing = costByResource.get(key)
    if (existing) existing.cost += row.Cost
    else costByResource.set(key, { cost: row.Cost, originalId: row.ResourceId })
  }

  const utilizationByResource = new Map<string, { slug: string; maxAvg: number }>()
  for (const m of usageMetrics) {
    const slug = resourceTypeSlug(m.resource_id)
    if (!slug) continue
    const relevantMetrics = UTILIZATION_METRICS_BY_SLUG[slug]
    if (!relevantMetrics || !relevantMetrics.includes(m.metric_name)) continue

    const { avg } = summarizeMetric(m)
    if (avg === null) continue

    const key = m.resource_id.toLowerCase()
    const existing = utilizationByResource.get(key)
    if (!existing || avg > existing.maxAvg) utilizationByResource.set(key, { slug, maxAvg: avg })
  }

  const findings: CostUsageWasteFinding[] = []
  for (const [key, { cost, originalId }] of costByResource) {
    const usage = utilizationByResource.get(key)
    if (!usage) continue
    if (cost < WASTE_MIN_COST_USD || usage.maxAvg > WASTE_MAX_UTILIZATION_PCT) continue

    findings.push({
      resource_id: originalId,
      resource_name: resourceNameFromId(originalId),
      resource_type: usage.slug,
      total_cost_usd: Math.round(cost * 100) / 100,
      utilization_pct: Math.round(usage.maxAvg * 100) / 100,
      cost_per_utilization_point_usd: Math.round((cost / Math.max(usage.maxAvg, 1)) * 100) / 100,
    })
  }

  return findings.sort((a, b) => b.total_cost_usd - a.total_cost_usd)
}

export interface CostPeriodDelta {
  key: string // resource name or service name
  current_usd: number
  previous_usd: number
  delta_usd: number
  delta_pct: number | null // null when previous was 0 (percentage undefined)
}

export interface CostPeriodComparison {
  current_total_usd: number
  previous_total_usd: number
  total_delta_usd: number
  total_delta_pct: number | null
  previous_period_from: string
  previous_period_to: string
  by_resource: CostPeriodDelta[]
  by_service: CostPeriodDelta[]
  truncated: boolean // true if by_resource/by_service were capped below MAX_DELTA_ROWS
}

const DELTA_MIN_ABSOLUTE_USD = 5 // ignore moves too small to matter
const MAX_DELTA_ROWS = 20

function groupTotals(rows: CostRow[], keyOf: (r: CostRow) => string): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    totals.set(key, (totals.get(key) || 0) + row.Cost)
  }
  return totals
}

function buildDeltas(current: Map<string, number>, previous: Map<string, number>): { deltas: CostPeriodDelta[]; truncated: boolean } {
  const keys = new Set([...current.keys(), ...previous.keys()])
  const deltas: CostPeriodDelta[] = []
  for (const key of keys) {
    const cur = current.get(key) || 0
    const prev = previous.get(key) || 0
    const delta = cur - prev
    if (Math.abs(delta) < DELTA_MIN_ABSOLUTE_USD) continue
    deltas.push({
      key,
      current_usd: Math.round(cur * 100) / 100,
      previous_usd: Math.round(prev * 100) / 100,
      delta_usd: Math.round(delta * 100) / 100,
      delta_pct: prev > 0 ? Math.round((delta / prev) * 1000) / 10 : null,
    })
  }
  deltas.sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd))
  const truncated = deltas.length > MAX_DELTA_ROWS
  return { deltas: deltas.slice(0, MAX_DELTA_ROWS), truncated }
}

// Compares this audit's cost data against the immediately prior audit of the
// SAME subscription (models/audit.ts's findPreviousAuditCostUsageRaw) —
// provable, reproducible numbers pulled straight from two audits' stored
// rows, not an estimate. Returns null when there is no prior audit to
// compare against (the subscription's first audit).
export function compareCostPeriods(
  currentRows: CostRow[],
  previous: { rows: CostRow[]; periodFrom: string; periodTo: string } | null | undefined
): CostPeriodComparison | null {
  if (!previous) return null

  const currentTotal = currentRows.reduce((s, r) => s + r.Cost, 0)
  const previousTotal = previous.rows.reduce((s, r) => s + r.Cost, 0)

  const byResourceResult = buildDeltas(
    groupTotals(currentRows, r => resourceNameFromId(r.ResourceId)),
    groupTotals(previous.rows, r => resourceNameFromId(r.ResourceId))
  )
  const byServiceResult = buildDeltas(
    groupTotals(currentRows, r => r.ServiceName),
    groupTotals(previous.rows, r => r.ServiceName)
  )

  return {
    current_total_usd: Math.round(currentTotal * 100) / 100,
    previous_total_usd: Math.round(previousTotal * 100) / 100,
    total_delta_usd: Math.round((currentTotal - previousTotal) * 100) / 100,
    total_delta_pct: previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 1000) / 10 : null,
    previous_period_from: previous.periodFrom,
    previous_period_to: previous.periodTo,
    by_resource: byResourceResult.deltas,
    by_service: byServiceResult.deltas,
    truncated: byResourceResult.truncated || byServiceResult.truncated,
  }
}

export interface CostForecast {
  period_from: string
  period_to: string
  historical_daily_avg_usd: number
  run_rate_next_30_days_usd: number
  trend_daily_delta_usd: number // linear-fit slope — positive means spend is trending up day over day
  trend_adjusted_next_30_days_usd: number
}

const FORECAST_MIN_DAYS = 14 // need enough history for a trend to mean anything
const FORECAST_RUN_RATE_WINDOW_DAYS = 30
const FORECAST_PROJECT_DAYS = 30

// Projects near-term spend two ways over the whole subscription's daily
// cost total: a flat run-rate (recent daily average x days), and a
// trend-adjusted figure from a least-squares linear fit over the full
// period, extrapolated forward — so "at this rate, what will next month
// cost" accounts for an ongoing upward/downward trend instead of assuming
// spend stays flat. Pure arithmetic over ActualCostRows; no LLM involved.
// Returns null when there isn't enough daily history yet to fit a trend.
export function forecastCost(costRows: CostRow[]): CostForecast | null {
  const byDate = new Map<number, number>()
  for (const row of costRows) {
    byDate.set(row.UsageDate, (byDate.get(row.UsageDate) || 0) + row.Cost)
  }
  if (byDate.size < FORECAST_MIN_DAYS) return null

  const sortedDates = Array.from(byDate.keys()).sort((a, b) => a - b)
  const series = sortedDates.map((date, x) => ({ x, y: byDate.get(date) as number }))

  const n = series.length
  const meanX = series.reduce((s, p) => s + p.x, 0) / n
  const meanY = series.reduce((s, p) => s + p.y, 0) / n
  let covXY = 0
  let varX = 0
  for (const p of series) {
    covXY += (p.x - meanX) * (p.y - meanY)
    varX += (p.x - meanX) ** 2
  }
  const slope = varX > 0 ? covXY / varX : 0
  const intercept = meanY - slope * meanX

  const recentWindow = series.slice(-FORECAST_RUN_RATE_WINDOW_DAYS)
  const recentAvg = recentWindow.reduce((s, p) => s + p.y, 0) / recentWindow.length

  const lastX = series[n - 1].x
  let trendProjectedTotal = 0
  for (let i = 1; i <= FORECAST_PROJECT_DAYS; i++) {
    trendProjectedTotal += Math.max(intercept + slope * (lastX + i), 0)
  }

  return {
    period_from: formatUsageDate(sortedDates[0]),
    period_to: formatUsageDate(sortedDates[n - 1]),
    historical_daily_avg_usd: Math.round(recentAvg * 100) / 100,
    run_rate_next_30_days_usd: Math.round(recentAvg * FORECAST_PROJECT_DAYS * 100) / 100,
    trend_daily_delta_usd: Math.round(slope * 100) / 100,
    trend_adjusted_next_30_days_usd: Math.round(trendProjectedTotal * 100) / 100,
  }
}

export interface ResourceGroupCostRollup {
  resource_group: string
  total_cost_usd: number
  resource_count: number
}

export interface TagCostRollup {
  tag_key: string
  tag_value: string
  total_cost_usd: number
  resource_count: number
}

// Builds a name -> {resourceGroup, tags} lookup from the inventory listing,
// the same name-matching approach detectZombieSpend uses (cost rows keep
// the full ARM id; every other extractor's cleaned output has it stripped —
// see cleaner.go). Returns null when the inventory was truncated, so
// callers can bail out rather than produce a rollup with silently missing
// resources folded into "ungrouped"/"untagged."
export function buildResourceInfoLookup(inventory: InventoryDataRaw | null | undefined): Map<string, InventoryResource> | null {
  if (!inventory || inventory.truncated) return null
  const lookup = new Map<string, InventoryResource>()
  for (const r of inventory.resources) lookup.set(r.name.toLowerCase(), r)
  return lookup
}

// Rolls total cost up by Azure resource group — the "which team/environment
// is driving spend" chargeback view finance/leadership usually actually
// wants, since resource groups are the natural cost-allocation boundary in
// most subscriptions. Pure grouping/sum over cost rows already collected.
export function rollupCostByResourceGroup(costRows: CostRow[], inventory: InventoryDataRaw | null | undefined): ResourceGroupCostRollup[] {
  const lookup = buildResourceInfoLookup(inventory)
  if (!lookup) return []

  const byGroup = new Map<string, { cost: number; resourceNames: Set<string> }>()
  for (const row of costRows) {
    if (!row.ResourceId) continue
    const name = resourceNameFromId(row.ResourceId).toLowerCase()
    const rg = lookup.get(name)?.resourceGroup || 'ungrouped'
    const entry = byGroup.get(rg) || { cost: 0, resourceNames: new Set<string>() }
    entry.cost += row.Cost
    entry.resourceNames.add(name)
    byGroup.set(rg, entry)
  }

  return Array.from(byGroup.entries())
    .map(([resource_group, { cost, resourceNames }]) => ({
      resource_group,
      total_cost_usd: Math.round(cost * 100) / 100,
      resource_count: resourceNames.size,
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
}

// Rolls total cost up by EVERY tag key/value pair present across the
// resources billing that cost — not hardcoded to "environment" or "team",
// since tag keys are entirely subscription-specific. A resource with
// multiple tags contributes its cost to each of its tag values (a resource
// tagged both env=prod and team=platform counts toward both rollups),
// which is intentional: chargeback questions get asked along different tag
// dimensions independently, not as one combined key.
export function rollupCostByTag(costRows: CostRow[], inventory: InventoryDataRaw | null | undefined): TagCostRollup[] {
  const lookup = buildResourceInfoLookup(inventory)
  if (!lookup) return []

  const byTag = new Map<string, { cost: number; resourceNames: Set<string> }>()
  for (const row of costRows) {
    if (!row.ResourceId) continue
    const name = resourceNameFromId(row.ResourceId).toLowerCase()
    const tags = lookup.get(name)?.tags
    if (!tags) continue
    for (const [key, value] of Object.entries(tags)) {
      const tagKey = `${key}::${value}`
      const entry = byTag.get(tagKey) || { cost: 0, resourceNames: new Set<string>() }
      entry.cost += row.Cost
      entry.resourceNames.add(name)
      byTag.set(tagKey, entry)
    }
  }

  return Array.from(byTag.entries())
    .map(([tagKey, { cost, resourceNames }]) => {
      const [tag_key, tag_value] = tagKey.split('::')
      return {
        tag_key,
        tag_value,
        total_cost_usd: Math.round(cost * 100) / 100,
        resource_count: resourceNames.size,
      }
    })
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
}

export interface ReservedInstanceCandidate {
  resource_id: string
  resource_name: string
  service_name: string
  daily_avg_usd: number
  coefficient_of_variation: number // stddev / mean — lower means steadier spend
  billed_days: number
}

const RI_MIN_DAILY_AVG_USD = 5 // ignore spend too small for a reservation to be worth the commitment
const RI_MAX_COEFFICIENT_OF_VARIATION = 0.15 // low variance = stable, not a spiky/seasonal workload
const RI_MIN_BILLED_DAYS = 60 // want most of the 90-day window present to trust "stable"

// Flags resources whose daily cost has been consistently high (low
// variance) across most of the collected period — the pattern that makes a
// Reserved Instance/Savings Plan commitment safe, as opposed to a resource
// with spiky cost (a poor commitment candidate, since committed capacity
// would sit unused on quiet days). Detection itself is pure stats (mean +
// stddev of daily cost, same building blocks as detectSpendSpikes); ANY
// judgment about whether committing is actually wise given the resource's
// other context (is it a permanent workload, might it be decommissioned
// soon per other findings) is left to the agent — this only supplies the
// stability signal, not the final recommendation.
export function detectReservedInstanceCandidates(costRows: CostRow[]): ReservedInstanceCandidate[] {
  const byResource = new Map<string, { serviceName: string; byDate: Map<number, number> }>()
  for (const row of costRows) {
    if (!row.ResourceId) continue
    const entry = byResource.get(row.ResourceId) || { serviceName: row.ServiceName || '', byDate: new Map<number, number>() }
    entry.byDate.set(row.UsageDate, (entry.byDate.get(row.UsageDate) || 0) + row.Cost)
    entry.serviceName = row.ServiceName || entry.serviceName
    byResource.set(row.ResourceId, entry)
  }

  const candidates: ReservedInstanceCandidate[] = []
  for (const [resourceId, { serviceName, byDate }] of byResource) {
    if (byDate.size < RI_MIN_BILLED_DAYS) continue

    const dailyCosts = Array.from(byDate.values())
    const avg = mean(dailyCosts)
    if (avg < RI_MIN_DAILY_AVG_USD) continue

    const sd = stddev(dailyCosts, avg)
    const cv = avg > 0 ? sd / avg : 0
    if (cv > RI_MAX_COEFFICIENT_OF_VARIATION) continue

    candidates.push({
      resource_id: resourceId,
      resource_name: resourceNameFromId(resourceId),
      service_name: serviceName,
      daily_avg_usd: Math.round(avg * 100) / 100,
      coefficient_of_variation: Math.round(cv * 1000) / 1000,
      billed_days: byDate.size,
    })
  }

  return candidates.sort((a, b) => b.daily_avg_usd - a.daily_avg_usd)
}
