'use client'

// Time-range filter pill group for chart headers. The brief asked for
// 1D/1W/1M/1Y buttons, but our data is one audit/day at most (no intraday
// granularity) — so the ranges are adapted to what audit cadence actually
// supports: a window of recent data points vs. everything.
export const RANGE_OPTIONS = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'all', label: 'All' },
] as const

export type RangeKey = typeof RANGE_OPTIONS[number]['key']

export function RangeFilter({ value, onChange }: { value: RangeKey; onChange: (key: RangeKey) => void }) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 999, padding: 2, gap: 2 }}>
      {RANGE_OPTIONS.map(opt => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className="chart-range-btn"
          data-active={value === opt.key}
          type="button"
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function filterByRange<T>(items: T[], key: RangeKey, getDate: (item: T) => string | Date): T[] {
  if (key === 'all') return items
  const days = key === '7d' ? 7 : key === '30d' ? 30 : 90
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return items.filter(item => new Date(getDate(item)).getTime() >= cutoff)
}
