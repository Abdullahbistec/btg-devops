// Shows a dollar estimate or a text label ("security risk") — the
// analysis-ui spec requires one or the other on every real finding, never
// an empty/unlabeled slot. Renders nothing for pre-migration findings that
// have neither (rather than showing a placeholder for every old row).
export function CostBadge({ usd, note }: { usd?: number | null; note?: string | null }) {
  if (usd != null) {
    return (
      <span className="bdg bdg-warning" style={{ fontFamily: 'ui-monospace, monospace' }}>
        ${Math.round(usd).toLocaleString()}/mo
      </span>
    )
  }
  if (note) return <span className="bdg bdg-muted">{note}</span>
  return null
}
