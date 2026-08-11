// Renders a fix as numbered steps inside a muted box — never a prose
// paragraph (analysis-ui spec). Falls back to treating a legacy flat
// `recommendation` string as a single step, so pre-migration findings still
// render something instead of nothing.
export function FixSteps({ steps, fallback }: { steps?: string[] | null; fallback?: string | null }) {
  const list = steps && steps.length > 0 ? steps : fallback ? [fallback] : []
  if (list.length === 0) return null

  return (
    <div style={{
      marginTop: '0.625rem', padding: '0.55rem 0.75rem', borderRadius: 6,
      background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)',
    }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#22c55e', marginBottom: list.length > 1 ? '0.3rem' : 0 }}>
        Fix
      </div>
      {list.length === 1 ? (
        <p style={{ fontSize: '0.78rem', color: 'var(--t2)', lineHeight: 1.5 }}>{list[0]}</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          {list.map((step, i) => (
            <li key={i} style={{ fontSize: '0.78rem', color: 'var(--t2)', lineHeight: 1.5 }}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  )
}
