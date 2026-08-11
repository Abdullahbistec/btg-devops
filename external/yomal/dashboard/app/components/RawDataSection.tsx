'use client'

import { useEffect, useState } from 'react'
import { ChevronRight, ChevronDown, Database, Code2 } from 'lucide-react'
import { api } from '../lib/api'
import { resourceMeta, ResourceIcon } from '../lib/resourceMeta'
import { formatNumber } from '../lib/utils'

type ResourceItem = Record<string, unknown>

const UNGROUPED = 'No resource group'

// Every extractor's payload has exactly one field holding the actual array
// of resources (e.g. { total_accounts, accounts: [...] }) — the field name
// differs per resource type, so this finds it generically instead of
// hardcoding all 12 names (same approach as region.ts's extractResources).
function findResourceArray(data: unknown): ResourceItem[] | null {
  if (!data || typeof data !== 'object') return null
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      return value.filter((item): item is ResourceItem => !!item && typeof item === 'object')
    }
  }
  return null
}

// resourceGroup is attached by the CLI's cleaner (parsed from the Azure
// resource ID) for every type except App Service Plans, which carry it
// natively under properties.resourceGroup instead.
function resourceGroupOf(item: ResourceItem): string {
  if (typeof item.resourceGroup === 'string') return item.resourceGroup
  const props = item.properties as Record<string, unknown> | undefined
  if (props && typeof props.resourceGroup === 'string') return props.resourceGroup
  return UNGROUPED
}

function locationOf(item: ResourceItem): string {
  if (typeof item.location === 'string') return item.location
  const props = item.properties as Record<string, unknown> | undefined
  if (props && typeof props.geoRegion === 'string') return props.geoRegion
  return '—'
}

// A handful of fields worth surfacing as extra columns when present — kept
// generic across all 12 resource types rather than a bespoke column set per
// type, so one table works everywhere (see the tradeoff discussed with the
// grouped-view mockup: generic columns lose some type-specific nuance, but
// avoid maintaining 12 separate column configs).
function extraFieldsOf(item: ResourceItem): { label: string; value: string }[] {
  const props = (item.properties as Record<string, unknown>) || {}
  const sku = item.sku as Record<string, unknown> | undefined
  const out: { label: string; value: string }[] = []
  if (sku?.name) out.push({ label: 'SKU', value: String(sku.name) })
  else if (item.kind) out.push({ label: 'Kind', value: String(item.kind) })
  if (props.provisioningState) out.push({ label: 'Status', value: String(props.provisioningState) })
  else if (props.status) out.push({ label: 'Status', value: String(props.status) })
  return out
}

function GroupedResourceTable({ items }: { items: ResourceItem[] }) {
  const grouped = new Map<string, ResourceItem[]>()
  for (const item of items) {
    const key = resourceGroupOf(item)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(item)
  }
  const groups = Array.from(grouped.entries()).sort(([a], [b]) => {
    if (a === UNGROUPED) return 1
    if (b === UNGROUPED) return -1
    return a.localeCompare(b)
  })
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  function toggle(key: string) {
    setCollapsed(s => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {groups.map(([groupName, groupItems]) => {
        const isCollapsed = collapsed.has(groupName)
        return (
          <div key={groupName} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <button
              onClick={() => toggle(groupName)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                padding: '0.55rem 0.7rem', background: 'var(--panel)', border: 'none',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              {isCollapsed ? <ChevronRight size={13} color="var(--t3)" /> : <ChevronDown size={13} color="var(--t3)" />}
              <span style={{
                fontFamily: 'ui-monospace, monospace', fontSize: '0.76rem', fontWeight: 600,
                color: groupName === UNGROUPED ? 'var(--t3)' : 'var(--t1)',
              }}>
                {groupName}
              </span>
              <span className="bdg bdg-muted" style={{ marginLeft: 'auto' }}>{groupItems.length}</span>
            </button>
            {!isCollapsed && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                  <thead>
                    <tr>
                      {['Name', 'Location', 'Details'].map(h => (
                        <th key={h} style={{
                          textAlign: 'left', padding: '0.4rem 0.7rem', color: 'var(--t3)',
                          fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                          borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groupItems.map((item, i) => (
                      <tr key={i}>
                        <td style={{ padding: '0.4rem 0.7rem', fontFamily: 'ui-monospace, monospace', color: 'var(--t1)', borderBottom: '1px solid var(--border)' }}>
                          {typeof item.name === 'string' ? item.name : '—'}
                        </td>
                        <td style={{ padding: '0.4rem 0.7rem', color: 'var(--t2)', borderBottom: '1px solid var(--border)' }}>
                          {locationOf(item)}
                        </td>
                        <td style={{ padding: '0.4rem 0.7rem', color: 'var(--t2)', borderBottom: '1px solid var(--border)' }}>
                          {extraFieldsOf(item).map(f => `${f.label}: ${f.value}`).join('  ·  ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ResourceRow({ auditId, slug, count, defaultOpen = false }: { auditId: string; slug: string; count: number; defaultOpen?: boolean }) {
  const [open, setOpen]       = useState(defaultOpen)
  const [data, setData]       = useState<unknown>(null)
  const [error, setError]     = useState('')
  const [showRawJson, setShowRawJson] = useState(false)
  // Derived, not its own state — avoids a synchronous setState call at the
  // top of the effect below (data/error only ever change from the .then/
  // .catch callbacks, which is fine; a bare setState at the effect's top
  // level is what the lint rule objects to).
  const loading = open && data === null && !error

  useEffect(() => {
    if (!open || data !== null || error) return
    let cancelled = false
    api.getAuditResource(auditId, slug)
      .then(result => { if (!cancelled) setData(result.data) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load') })
    return () => { cancelled = true }
  }, [open, data, error, auditId, slug])

  const items = data !== null ? findResourceArray(data) : null

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(v => !v)}
        className="row-hover"
        style={{
          display: 'flex', alignItems: 'center', gap: '0.625rem', width: '100%',
          padding: '0.7rem 0.5rem', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={14} color="var(--t3)" /> : <ChevronRight size={14} color="var(--t3)" />}
        <ResourceIcon slug={slug} size={14} />
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', color: 'var(--t1)' }}>{slug}</span>
        <span className="hidden sm:inline" style={{ fontSize: '0.75rem', color: 'var(--t3)' }}>
          {resourceMeta(slug).label}
        </span>
        <span className="bdg bdg-muted" style={{ marginLeft: 'auto' }}>{count}</span>
      </button>

      {open && (
        <div style={{ padding: '0 0.5rem 0.875rem 2rem' }}>
          {loading && <p style={{ fontSize: '0.75rem', color: 'var(--t3)' }}>Loading…</p>}
          {error && <p style={{ fontSize: '0.75rem', color: '#ef4444' }}>{error}</p>}

          {data !== null && items && items.length > 0 && (
            <>
              <button
                onClick={() => setShowRawJson(v => !v)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.625rem',
                  background: 'none', border: 'none', color: 'var(--t3)', fontSize: '0.7rem', cursor: 'pointer', padding: 0,
                }}
              >
                <Code2 size={12} /> {showRawJson ? 'Show grouped view' : 'View raw JSON'}
              </button>
              {showRawJson ? (
                <pre style={{
                  background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
                  padding: '0.875rem', fontSize: '0.7rem', color: 'var(--t2)',
                  fontFamily: 'ui-monospace, monospace', overflowX: 'auto', maxHeight: 360, overflowY: 'auto',
                  lineHeight: 1.5,
                }}>
                  {JSON.stringify(data, null, 2)}
                </pre>
              ) : (
                <GroupedResourceTable items={items} />
              )}
            </>
          )}

          {/* No array field found (e.g. shape this component doesn't recognize) — fall back to raw JSON. */}
          {data !== null && !items && (
            <pre style={{
              background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '0.875rem', fontSize: '0.7rem', color: 'var(--t2)',
              fontFamily: 'ui-monospace, monospace', overflowX: 'auto', maxHeight: 360, overflowY: 'auto',
              lineHeight: 1.5,
            }}>
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export function RawDataSection({ auditId, resourceCounts, selectedType }: {
  auditId: string
  resourceCounts: Record<string, number>
  // The resource type currently selected in the Analyze dropdown above —
  // when it's one of this audit's actual resource types, only that type's
  // raw data is shown (auto-expanded) instead of all of them at once.
  // Scopes like "all"/"cost"/"usage:<type>" aren't a single resource type,
  // so those fall back to showing every type.
  selectedType?: string
}) {
  const allSlugs = Object.keys(resourceCounts || {}).sort()
  const isSingleType = !!selectedType && allSlugs.includes(selectedType)
  const [showAll, setShowAll] = useState(false)
  const slugs = isSingleType && !showAll ? [selectedType] : allSlugs
  const totalResources = Object.values(resourceCounts || {}).reduce((s, n) => s + n, 0)

  // Collapsed by default — this is debug/verification data most visits
  // never touch, so it shouldn't cost scroll distance below the analysis
  // panel. Picking a specific scope above (isSingleType) auto-opens it,
  // since the reader has already signaled they want to look at that type.
  // The parent remounts this component (via a `key` on selectedType) when
  // the scope changes, so this initial state re-derives per scope without
  // an effect.
  const [sectionOpen, setSectionOpen] = useState(isSingleType)

  return (
    <div className="glass" style={{ padding: sectionOpen ? '1.25rem' : '0' }}>
      <button
        onClick={() => setSectionOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', flexWrap: 'wrap',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          padding: sectionOpen ? '0 0 0.5rem' : '0.85rem 1.1rem',
        }}
      >
        {sectionOpen ? <ChevronDown size={14} color="var(--t3)" /> : <ChevronRight size={14} color="var(--t3)" />}
        <Database size={15} color="var(--acc)" />
        <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--t1)' }}>Raw Resource Data</h2>
        {!sectionOpen && (
          <span style={{ fontSize: '0.72rem', color: 'var(--t4)' }}>
            {allSlugs.length} resource types · {formatNumber(totalResources)} resources — click to inspect
          </span>
        )}
      </button>

      {sectionOpen && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            {isSingleType && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--acc)',
                  fontSize: '0.72rem', cursor: 'pointer', padding: 0,
                }}
              >
                Show all {allSlugs.length} resource types
              </button>
            )}
            {isSingleType && showAll && (
              <button
                onClick={() => setShowAll(false)}
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--acc)',
                  fontSize: '0.72rem', cursor: 'pointer', padding: 0,
                }}
              >
                Show only {selectedType}
              </button>
            )}
          </div>
          {slugs.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--t3)', padding: '0.75rem 0' }}>No resource data in this audit.</p>
          ) : (
            slugs.map(slug => (
              <ResourceRow key={slug} auditId={auditId} slug={slug} count={resourceCounts[slug]} defaultOpen={isSingleType && !showAll} />
            ))
          )}
        </>
      )}
    </div>
  )
}
