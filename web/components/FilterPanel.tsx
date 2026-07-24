'use client';
import { useState } from 'react';

interface Filters {
  severity: string;
  service: string;
  auditId: string;
}

interface Props {
  filters: Filters;
  onChange: (f: Filters) => void;
  audits: { id: string; name: string }[];
  services: string[];
  onReset: () => void;
  subscriptionId: string;
  onAuditTriggered?: () => void;
}

export default function FilterPanel({ filters, onChange, audits, services, onReset, subscriptionId, onAuditTriggered }: Props) {
  const [running, setRunning] = useState(false);

  async function runAudit() {
    setRunning(true);
    try {
      await fetch('/api/audits/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription_id: subscriptionId }),
      });
      onAuditTriggered?.();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="glass-sb" style={{
      width: 165, flexShrink: 0,
      borderRight: '1px solid var(--border)',
      padding: '12px 10px', overflowY: 'auto',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 3h10M3 6h6M5 9h2"/></svg>
        Filter
      </div>

      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Audit</div>
        <select value={filters.auditId} onChange={e => onChange({ ...filters, auditId: e.target.value })} style={selectStyle}>
          <option value="">Latest</option>
          {audits.map(a => <option key={a.id} value={a.id}>{a.name?.slice(0, 22)}</option>)}
        </select>
      </div>

      <div style={{ height: 1, background: 'var(--border)' }} />

      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Severity</div>
        <select value={filters.severity} onChange={e => onChange({ ...filters, severity: e.target.value })} style={selectStyle}>
          <option value="">All</option>
          <option>Critical</option>
          <option>Warning</option>
          <option>Info</option>
        </select>
      </div>

      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Service</div>
        <select value={filters.service} onChange={e => onChange({ ...filters, service: e.target.value })} style={selectStyle}>
          <option value="">All</option>
          {services.map(s => <option key={s}>{s}</option>)}
        </select>
      </div>

      <div style={{ height: 1, background: 'var(--border)' }} />

      <button onClick={onReset} style={{ width: '100%', padding: 7, background: 'var(--accent)', border: 'none', borderRadius: 3, color: '#fff', fontSize: 11, fontWeight: 700 }}>
        Reset Filter
      </button>

      <button onClick={runAudit} disabled={running} style={{
        width: '100%', padding: 7, background: 'transparent',
        border: '1px solid var(--accent2)', borderRadius: 3,
        color: 'var(--accent2)', fontSize: 11, fontWeight: 700,
        opacity: running ? 0.6 : 1,
      }}>
        {running ? '⟳ Running…' : '▶ Run New Audit'}
      </button>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%', background: 'var(--card2)', border: '1px solid var(--border)',
  color: 'var(--text)', fontSize: 11, padding: '5px 8px', borderRadius: 3,
  outline: 'none', fontFamily: 'inherit', cursor: 'pointer',
  appearance: 'none',
};
