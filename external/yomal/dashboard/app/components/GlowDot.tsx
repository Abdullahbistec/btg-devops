'use client'

// Custom active-dot renderer for recharts Line/Area — a glowing core with a
// pulsing ripple ring, matching the "glowing circular marker with subtle
// ripple" spec. Recharts calls this with cx/cy/stroke injected as props.
export function GlowDot(props: { cx?: number; cy?: number; stroke?: string }) {
  const { cx, cy, stroke = '#8B5CF6' } = props
  if (cx == null || cy == null) return null
  return (
    <g>
      <circle cx={cx} cy={cy} r={9} fill={stroke} opacity={0.18} className="chart-ripple" style={{ transformOrigin: `${cx}px ${cy}px` }} />
      <circle cx={cx} cy={cy} r={5} fill={stroke} opacity={0.25} />
      <circle cx={cx} cy={cy} r={3.5} fill={stroke} stroke="#fff" strokeWidth={1.5} />
    </g>
  )
}
