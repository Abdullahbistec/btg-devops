export interface ResourceDiff {
  slug: string
  before: number
  after: number
  delta: number
}

export function compareCounts(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined
): ResourceDiff[] {
  const slugs = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  return Array.from(slugs)
    .map(slug => {
      const before = a?.[slug] || 0
      const after  = b?.[slug] || 0
      return { slug, before, after, delta: after - before }
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.slug.localeCompare(y.slug))
}
