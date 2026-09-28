'use client';

export function KPISkeletonRow() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.6fr repeat(4,1fr)', gap: 8 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="glass" style={{
          borderRadius: 8, padding: '10px 12px 10px 16px',
          height: i === 0 ? 96 : 84, display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center',
        }}>
          <div className="skel" style={{ width: '55%', height: 9 }} />
          <div className="skel" style={{ width: '70%', height: i === 0 ? 30 : 22 }} />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 155 }: { height?: number }) {
  return (
    <div className="glass" style={{ borderRadius: 8, padding: '10px 12px 10px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="skel" style={{ width: '40%', height: 10 }} />
      <div className="skel" style={{ width: '100%', height }} />
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="glass" style={{ borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="skel" style={{ width: '30%', height: 12 }} />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 10 }}>
          <div className="skel" style={{ width: 60, height: 16 }} />
          <div className="skel" style={{ width: 90, height: 16 }} />
          <div className="skel" style={{ flex: 1, height: 16 }} />
        </div>
      ))}
    </div>
  );
}
