import { cn } from '../lib/utils'

interface BadgeProps {
  color?: string
  label: string
  className?: string
}

export function Badge({ color = 'muted', label, className }: BadgeProps) {
  return (
    <span className={cn('bdg', `bdg-${color}`, className)}>
      {label}
    </span>
  )
}
