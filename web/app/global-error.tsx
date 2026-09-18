'use client';

import { useEffect } from 'react';

/** Catches an error in the ROOT layout itself (app/layout.tsx) — the one
 * failure mode app/error.tsx cannot catch, since that boundary lives inside
 * the layout it would need to replace. Per Next.js convention this file must
 * render its own <html>/<body>; it can't assume the root layout's markup (or
 * even that globals.css's custom properties are available) since the layout
 * that would normally provide them is exactly what failed. Kept self-
 * contained with literal colors matching the dashboard's dark theme rather
 * than depending on CSS variables. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[root layout error boundary]', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0B1930', color: '#E8ECF8', fontFamily: "'Segoe UI', -apple-system, system-ui, sans-serif" }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24 }}>
          <div style={{
            padding: 32, maxWidth: 440, textAlign: 'center', borderRadius: 16,
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🛑</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>The dashboard failed to load</div>
            <div style={{ fontSize: 12, color: '#A0AECF', marginBottom: 20, lineHeight: 1.6 }}>
              A critical error occurred before the page could render. It has been logged.
            </div>
            <button
              onClick={reset}
              style={{
                padding: '9px 18px', borderRadius: 8, border: '1px solid #00C2FF',
                background: 'rgba(0,194,255,0.12)', color: '#00C2FF', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
