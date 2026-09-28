'use client';
import { useEffect, useRef, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';

interface KPICardProps {
  label: string;
  value: string | number;
  delta?: string;
  deltaPositive?: boolean;
  color?: string;
  sparkData?: number[];
  icon?: React.ReactNode;
  iconBg?: string;
  hero?: boolean;
}

/** Eases a numeric value change into view instead of snapping — purely
 * cosmetic, and a no-op (renders the raw value) whenever `value` isn't a
 * finite number, e.g. the "—" placeholder shown before the first audit. */
function useCountUp(value: string | number, duration = 550): string | number {
  const numeric = typeof value === 'number' ? value : Number(value);
  const isAnimatable = typeof value === 'number' || (value !== '' && Number.isFinite(numeric));
  const [display, setDisplay] = useState(numeric);
  const prevRef = useRef(numeric);

  useEffect(() => {
    if (!isAnimatable) return;
    const start = prevRef.current;
    const diff = numeric - start;
    if (diff === 0) { setDisplay(numeric); return; }
    const startTime = performance.now();
    let raf: number;
    function tick(now: number) {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(start + diff * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevRef.current = numeric;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numeric, isAnimatable, duration]);

  return isAnimatable ? display : value;
}

export default function KPICard({ label, value, delta, deltaPositive, color = '#00C2FF', sparkData, icon, iconBg, hero }: KPICardProps) {
  const spark = sparkData?.map(v => ({ v })) ?? [];
  const shown = useCountUp(value);

  return (
    <div className="glass dash-card" style={{
      borderRadius: 8,
      padding: hero ? '14px 16px 14px 20px' : '10px 12px 10px 16px', display: 'flex', flexDirection: 'column', gap: 0,
      cursor: 'default',
      border: `1px solid ${color}66`,
      boxShadow: `0 0 ${hero ? 26 : 18}px ${color}22, 0 4px 24px rgba(0,0,0,0.15), inset 0 1px 0 ${color}18`,
      position: 'relative', overflow: 'hidden',
    }}
    >
      {/* Coloured left accent bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: hero ? 4 : 3, background: `linear-gradient(180deg, ${color}, ${color}33)`, borderRadius: '8px 0 0 8px' }} />
      {/* Subtle top glow line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, ${color}88, transparent)` }} />
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: hero ? 8 : 6 }}>
        <span style={{ fontSize: hero ? 10.5 : 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
          {label}
        </span>
        {icon && (
          <div style={{
            width: hero ? 26 : 22, height: hero ? 26 : 22, borderRadius: 4,
            background: iconBg ?? `${color}1A`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {icon}
          </div>
        )}
      </div>

      {/* Value */}
      <div style={{ fontSize: hero ? '2.5rem' : '1.65rem', fontWeight: 800, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums', marginBottom: 3 }}>
        {shown}
      </div>

      {/* Delta */}
      {delta && (
        <div style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
          <span style={{ color: deltaPositive ? 'var(--good)' : 'var(--crit)', fontWeight: 600 }}>
            {delta}
          </span>
          <span style={{ color: 'var(--muted)' }}>vs last audit</span>
        </div>
      )}

      {/* Sparkline */}
      {spark.length > 1 && (
        <div style={{ height: hero ? 48 : 28, marginTop: 4 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`sg-${label.replace(/\s/g,'')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke={color} strokeWidth={hero ? 2 : 1.5} fill={`url(#sg-${label.replace(/\s/g,'')})`} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
