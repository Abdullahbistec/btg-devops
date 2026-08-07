'use client';
import { useState } from 'react';

interface Props {
  subscriptionId: string;
  onComplete?: () => void;
}

export default function RunAuditButton({ subscriptionId, onComplete }: Props) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [auditId, setAuditId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setState('running');
    setError('');
    try {
      const res = await fetch('/api/audits/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription_id: subscriptionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAuditId(data.audit_id);
      setState('done');
      setTimeout(() => {
        setState('idle');
        onComplete?.();
      }, 3000);
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  }

  const colors: Record<string, string> = {
    idle: '#00C2FF', running: '#FFA502', done: '#2ED573', error: '#FF4757',
  };
  const labels: Record<string, string> = {
    idle: '▶ Run Audit', running: '⟳ Running…', done: '✓ Audit started', error: '✕ Failed',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        disabled={state === 'running'}
        onClick={run}
        style={{
          fontSize: 11, fontWeight: 700, padding: '5px 14px', borderRadius: 3,
          border: `1px solid ${colors[state]}`,
          background: state === 'idle' ? colors[state] : 'transparent',
          color: state === 'idle' ? '#fff' : colors[state],
          opacity: state === 'running' ? 0.7 : 1,
          transition: 'all 0.15s',
        }}
      >
        {labels[state]}
      </button>
      {state === 'done' && auditId && (
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>ID: {auditId.slice(0, 8)}…</span>
      )}
      {state === 'error' && (
        <span style={{ fontSize: 10, color: 'var(--crit)' }}>{error}</span>
      )}
    </div>
  );
}
