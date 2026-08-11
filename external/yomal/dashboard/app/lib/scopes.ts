import { resourceMeta } from './resourceMeta'

export interface UsageTypeInfo { slug: string; count: number }

export interface ScopeOption { value: string; label: string }
export interface ScopeGroup { label: string; options: ScopeOption[] }

/**
 * Builds the scope dropdown options shared by the Analyze panel and Chat
 * panel — one "Resource types" group (12 audit resource types with counts)
 * and one "Cost & Usage" group (cost + one entry per resource type that has
 * usage metrics, e.g. "usage:storage"). Both panels render identically from
 * this so the two stay in sync as new scope kinds are added.
 */
export function buildScopeGroups(
  resourceCounts: Record<string, number>,
  hasCost: boolean,
  usageTypes: UsageTypeInfo[]
): ScopeGroup[] {
  const groups: ScopeGroup[] = []

  const resourceKeys = Object.keys(resourceCounts || {}).sort()
  if (resourceKeys.length > 0) {
    groups.push({
      label: 'Resource types',
      options: resourceKeys.map(t => ({ value: t, label: `${t} (${resourceCounts[t]} resources)` })),
    })
  }

  const extra: ScopeOption[] = []
  if (hasCost) extra.push({ value: 'cost', label: 'Cost Management data' })
  for (const u of usageTypes) {
    extra.push({ value: `usage:${u.slug}`, label: `Usage — ${resourceMeta(u.slug).label} (${u.count})` })
  }
  if (extra.length > 0) groups.push({ label: 'Cost & Usage', options: extra })

  return groups
}

export function scopeLabel(scope: string, groups: ScopeGroup[]): string {
  for (const g of groups) {
    const found = g.options.find(o => o.value === scope)
    if (found) return found.label
  }
  return scope
}

export function firstScope(groups: ScopeGroup[]): string | undefined {
  return groups[0]?.options[0]?.value
}
