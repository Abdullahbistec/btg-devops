import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface SectionHeaderProps {
  icon: LucideIcon
  title: string
  caption?: string
  action?: ReactNode
}

// Consistent zone label used to break the dashboard into visually distinct
// groups (Overview, Performance, Regional Insights, ...) instead of an
// undifferentiated stack of same-looking cards.
export function SectionHeader({ icon: Icon, title, caption, action }: SectionHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.875rem' }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8, background: 'var(--acc-soft)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={14} color="var(--acc)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--t1)', letterSpacing: '-0.01em' }}>
          {title}
        </h2>
        {caption && (
          <p style={{ fontSize: '0.72rem', color: 'var(--t4)', marginTop: '0.1rem' }}>{caption}</p>
        )}
      </div>
      {action}
    </div>
  )
}
