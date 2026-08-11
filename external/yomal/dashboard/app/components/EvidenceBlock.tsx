// Renders the raw field/value proof behind a finding's `issue` as its own
// "why this is flagged" section — split from FixSteps' green "Fix" box so a
// reader can visually separate "the proof" from "the remedy". Omitted
// entirely when absent (findings saved before this field existed).
export function EvidenceBlock({ evidence }: { evidence?: string | null }) {
  if (!evidence) return null

  return (
    <div style={{
      marginTop: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: 6,
      background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)',
    }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#38bdf8', marginBottom: '0.2rem' }}>
        Why this is flagged
      </div>
      <p style={{
        fontSize: '0.76rem', color: 'var(--t2)', lineHeight: 1.5,
        fontFamily: 'ui-monospace, monospace',
      }}>
        {evidence}
      </p>
    </div>
  )
}
