'use client';
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
}

export default function KPICard({ label, value, delta, deltaPositive, color = '#00C2FF', sparkData, icon, iconBg }: KPICardProps) {
  const spark = sparkData?.map(v => ({ v })) ?? [];

  return (
    <div className="glass" style={{
      borderRadius: 8,
      padding: '10px 12px 10px 16px', display: 'flex', flexDirection: 'column', gap: 0,
      cursor: 'default',
      border: `1px solid ${color}66`,
      boxShadow: `0 0 18px ${color}22, 0 4px 24px rgba(0,0,0,0.15), inset 0 1px 0 ${color}18`,
      position: 'relative', overflow: 'hidden',
    }}
    >
      {/* Coloured left accent bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 3, background: `linear-gradient(180deg, ${color}, ${color}33)`, borderRadius: '8px 0 0 8px' }} />
      {/* Subtle top glow line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, ${color}88, transparent)` }} />
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)' }}>
          {label}
        </span>
        {icon && (
          <div style={{
            width: 22, height: 22, borderRadius: 4,
            background: iconBg ?? `${color}1A`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {icon}
          </div>
        )}
      </div>

      {/* Value */}
      <div style={{ fontSize: '1.65rem', fontWeight: 800, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums', marginBottom: 3 }}>
        {value}
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
        <div style={{ height: 28, marginTop: 4 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`sg-${label.replace(/\s/g,'')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#sg-${label.replace(/\s/g,'')})`} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
