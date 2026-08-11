import { CSSProperties } from 'react'

interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number
  style?: CSSProperties
}

export function Skeleton({ width = '100%', height = 14, radius = 6, style }: SkeletonProps) {
  return <div className="skeleton" style={{ width, height, borderRadius: radius, ...style }} />
}

export function KPISkeletonRow() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="glass" style={{ padding: '1.125rem 1.25rem' }}>
          <Skeleton width={90} height={10} style={{ marginBottom: '0.75rem' }} />
          <Skeleton width={70} height={26} />
          <Skeleton width={120} height={10} style={{ marginTop: '0.6rem' }} />
        </div>
      ))}
    </div>
  )
}

export function ChartSkeleton() {
  const bars = [55, 85, 40, 70, 50, 95, 35, 62]
  return (
    <div className="glass" style={{ padding: '1.25rem' }}>
      <Skeleton width={160} height={16} style={{ marginBottom: '1.25rem' }} />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.75rem', height: 260, padding: '0 0.5rem' }}>
        {bars.map((h, i) => (
          <Skeleton key={i} height={`${h}%`} radius={4} />
        ))}
      </div>
    </div>
  )
}

export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="glass" style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} style={{ display: 'flex', gap: '1rem' }}>
            {Array.from({ length: cols }).map((__, c) => (
              <Skeleton key={c} height={12} width={c === 0 ? 90 : undefined} style={c === 0 ? undefined : { flex: 1 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function DetailSkeleton() {
  return (
    <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="glass" style={{ padding: '1.25rem' }}>
        <Skeleton width={220} height={20} style={{ marginBottom: '0.75rem' }} />
        <Skeleton width={320} height={12} style={{ marginBottom: '1.25rem' }} />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} height={52} radius={8} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3">
          <div className="glass" style={{ padding: '1.25rem' }}>
            <Skeleton width={140} height={16} style={{ marginBottom: '1rem' }} />
            <Skeleton height={120} radius={8} />
          </div>
        </div>
        <div className="lg:col-span-2">
          <div className="glass" style={{ padding: '1.25rem' }}>
            <Skeleton width={160} height={16} style={{ marginBottom: '1rem' }} />
            <Skeleton height={220} radius={8} />
          </div>
        </div>
      </div>
    </div>
  )
}
