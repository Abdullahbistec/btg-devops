// Region distribution + cross-region mismatch detection — deterministic,
// no LLM involved. Every Azure resource has a `location` field; this reads
// it directly rather than asking a model to notice regional spread.

export interface RegionResource {
  type: string
  name: string
  location: string
}

// Each extractor's data object has exactly one array field holding the
// actual resources (e.g. raw_data.storage = { total_accounts, accounts: [...] },
// raw_data.functions = { total_function_apps, function_apps: [...] }) — the
// field name differs per extractor, so this finds it generically instead of
// hardcoding all 12 names.
function extractResources(resourceType: string, data: unknown): RegionResource[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  for (const value of Object.values(obj)) {
    if (!Array.isArray(value)) continue
    return value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map(item => ({
        type: resourceType,
        name: typeof item.name === 'string' ? item.name : 'unnamed',
        // Different ARM providers report location differently for the SAME
        // region — e.g. Cosmos DB/Functions/App Service Plan return "Southeast
        // Asia" (Title Case, space) while Storage/NSG/ACR return "southeastasia"
        // (canonical, no space). Stripping whitespace normalizes both to the
        // same key — confirmed against real audit data, where without this,
        // one real region fragmented into two chart bars and produced false
        // "cross-region" warnings for resources actually co-located.
        location: typeof item.location === 'string' ? item.location.toLowerCase().replace(/\s+/g, '') : '',
      }))
      .filter(r => r.location)
  }
  return []
}

export interface RegionDistributionEntry { region: string; count: number }

export function computeRegionDistribution(rawData: Record<string, unknown>): RegionDistributionEntry[] {
  const counts = new Map<string, number>()
  for (const [type, data] of Object.entries(rawData)) {
    if (type === 'collected_at' || type === 'subscription_id') continue
    for (const r of extractResources(type, data)) {
      counts.set(r.location, (counts.get(r.location) || 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => b.count - a.count)
}

// Compute (app/logic) vs data (storage/database) resource types — the two
// halves of the cross-region cost/latency pattern this checks for.
const COMPUTE_TYPES = ['appservice', 'functions', 'appserviceplan']
const DATA_TYPES = ['cosmosdb', 'storage']

export interface RegionMismatch {
  region: string
  computeResources: { type: string; name: string }[]
  dataRegions: string[]
}

// Flags regions that have compute resources but NO data resource (Cosmos DB
// or Storage) in that same region. This is a hint, not proof — it can't see
// which app actually calls which database (that lives in app config, which
// isn't collected), so it surfaces "these are geographically split, worth
// checking" rather than asserting a confirmed problem.
export function computeCrossRegionMismatches(rawData: Record<string, unknown>): RegionMismatch[] {
  const compute: RegionResource[] = []
  const dataRegionSet = new Set<string>()

  for (const [type, data] of Object.entries(rawData)) {
    if (COMPUTE_TYPES.includes(type)) compute.push(...extractResources(type, data))
    if (DATA_TYPES.includes(type)) {
      for (const r of extractResources(type, data)) dataRegionSet.add(r.location)
    }
  }

  if (dataRegionSet.size === 0) return [] // no data resources collected at all — nothing to compare against

  const byRegion = new Map<string, { type: string; name: string }[]>()
  for (const c of compute) {
    if (dataRegionSet.has(c.location)) continue // this region already has local data — not a mismatch
    const list = byRegion.get(c.location) || []
    list.push({ type: c.type, name: c.name })
    byRegion.set(c.location, list)
  }

  return Array.from(byRegion.entries())
    .map(([region, computeResources]) => ({ region, computeResources, dataRegions: Array.from(dataRegionSet) }))
    .sort((a, b) => b.computeResources.length - a.computeResources.length)
}
