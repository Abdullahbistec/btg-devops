'use client';

import { useEffect } from 'react';

/** Route-level error boundary (Next.js App Router convention). Without this
 * file, an uncaught render/data error in any page falls through to Next's
 * generic overlay in dev or a blank/minimal error in production — this
 * catches it in-place, matches the dashboard's visual language, and offers
 * a way back instead of a dead end. Does not catch errors in this same
 * segment's layout — see global-error.tsx for that. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[route error boundary]', error);
  }, [error]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24 }}>
      <div className="glass" style={{ padding: 32, maxWidth: 440, textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
          Something went wrong
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.6 }}>
          This page hit an unexpected error. It has been logged; try again or head back to the dashboard.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            onClick={reset}
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid var(--accent)',
              background: 'rgba(0,194,255,0.12)', color: 'var(--accent)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <a
            href="/dashboard"
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid var(--border)',
              background: 'var(--card2)', color: 'var(--text)', fontSize: 12, fontWeight: 700,
              textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
            }}
          >
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
