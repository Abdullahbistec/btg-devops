export function formatNumber(n: number): string {
  return n.toLocaleString()
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

export const statusConfig: Record<string, { label: string; color: string }> = {
  completed: { label: 'Completed', color: 'success' },
  running:   { label: 'Running',   color: 'info' },
  failed:    { label: 'Failed',    color: 'error' },
}

export const triggerConfig: Record<string, { label: string; color: string }> = {
  scheduled: { label: 'Scheduled', color: 'purple' },
  manual:    { label: 'Manual',    color: 'muted' },
}

export const roleConfig: Record<string, { label: string; color: string }> = {
  admin:   { label: 'Admin',   color: 'error' },
  analyst: { label: 'Analyst', color: 'info' },
  viewer:  { label: 'Viewer',  color: 'muted' },
}

export const severityConfig: Record<string, { label: string; color: string }> = {
  Critical: { label: 'Critical', color: 'error' },
  Warning:  { label: 'Warning',  color: 'warning' },
  Info:     { label: 'Info',     color: 'info' },
}

export const findingStatusConfig: Record<string, { label: string; color: string }> = {
  open:      { label: 'Open',      color: 'info' },
  resolved:  { label: 'Resolved',  color: 'success' },
  dismissed: { label: 'Dismissed', color: 'muted' },
}

// Age badge for a finding, based on when the issue was FIRST flagged across
// audits (first_seen_at carries forward between runs — see saveFindings).
// Escalating color: fresh issues are neutral, week-old ones amber, and
// month-old ones red — an unfixed problem visibly "ages" on the card.
export function findingAge(firstSeenAt: string): { label: string; color: string } {
  const days = Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / 86_400_000)
  if (days <= 0) return { label: 'New', color: 'success' }
  const label = days === 1 ? '1 day old' : `${days} days old`
  if (days >= 30) return { label, color: 'error' }
  if (days >= 7)  return { label, color: 'warning' }
  return { label, color: 'muted' }
}
