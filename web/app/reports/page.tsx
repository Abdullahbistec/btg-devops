'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';

const CMD_COLORS: Record<string, string> = {
  'appservice-traffic': '#00C2FF',
  'storage':            '#FFA502',
  'nsg':                '#FF4757',
  'acr':                '#7B5EA7',
  'cosmosdb':           '#2ED573',
  'keyvault':           '#FFD166',
  'functions':          '#FF6B9D',
  'publicip':           '#54A0FF',
  'appserviceplan':     '#00B894',
  'cognitiveservices':  '#A29BFE',
  'resourcegroup':      '#FD79A8',
  'iam':                '#E17055',
  'sp-expiry':          '#FDCB6E',
  'powerplatform':      '#00CEC9',
  'pp-environments':    '#6C5CE7',
  'pp-apps':            '#55EFC4',
  'pp-flows':           '#74B9FF',
  'pp-powerbi':         '#F9CA24',
};

interface Audit {
  id: string;
  name: string;
  status: string;
  started_at: string;
  completed_at: string;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  commands_run: string;
}

interface Finding {
  id: string;
  service: string;
  severity: string;
  category: string;
  resource: string;
  description: string;
  recommendation: string;
}

const ACCENT = '#00C2FF';
const CRIT = '#FF4757';
const WARN = '#FFA502';
const INFO = '#54A0FF';

function sevColor(s: string) {
  if (s === 'Critical') return CRIT;
  if (s === 'Warning') return WARN;
  return INFO;
}

function csvCell(v: string) {
  return `"${v.replace(/\n/g, ' ').replace(/"/g, '""')}"`;
}

function downloadCSV(audit: Audit, findings: Finding[]) {
  const header = ['Severity', 'Service', 'Category', 'Resource', 'Description', 'Recommendation'];
  const rows = findings.map(f => [
    f.severity, f.service, f.category, f.resource, f.description, f.recommendation,
  ]);
  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `btg-report-${audit.name.replace(/[^a-z0-9]/gi, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetch('/api/audits')
      .then(r => r.json())
      .then((data: Audit[]) => {
        const done = Array.isArray(data) ? data.filter(a => a.status === 'completed') : [];
        setAudits(done);
        if (done.length > 0) setSelected(done[0].id);
      });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetch(`/api/findings?audit_id=${selected}`)
      .then(r => r.json())
      .then((data: Finding[]) => {
        setFindings(Array.isArray(data) ? data : []);
        setLoading(false);
      });
  }, [selected]);

  const audit = audits.find(a => a.id === selected);
  const commands: string[] = audit ? (() => { try { return JSON.parse(audit.commands_run); } catch { return []; } })() : [];

  const filtered = filter === 'all' ? findings : findings.filter(f => f.severity === filter);

  const bySev: Record<string, Finding[]> = { Critical: [], Warning: [], Info: [] };
  for (const f of filtered) {
    (bySev[f.severity] = bySev[f.severity] || []).push(f);
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Topbar */}
        <div className="glass-sb" style={{ borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Reports</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>Export and review audit findings</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <select value={selected} onChange={e => setSelected(e.target.value)}
              style={{ fontSize: 11, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '4px 8px' }}>
              {audits.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {audit && (
              <>
                <div className="no-print" style={{ display: 'flex', gap: 4 }}>
                  {['all', 'Critical', 'Warning', 'Info'].map(f => (
                    <button key={f} onClick={() => setFilter(f)}
                      style={{ padding: '2px 8px', fontSize: 10, fontWeight: 600, borderRadius: 3, cursor: 'pointer',
                        background: filter === f ? 'var(--accent)' : 'transparent',
                        border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`,
                        color: filter === f ? '#fff' : 'var(--muted)' }}>
                      {f === 'all' ? 'All' : f}
                    </button>
                  ))}
                </div>
                <button onClick={() => downloadCSV(audit, filtered)}
                  style={{ padding: '5px 12px', fontSize: 11, fontWeight: 700, background: ACCENT, border: 'none', borderRadius: 3, color: '#000', cursor: 'pointer' }}
                  className="no-print">
                  ↓ Export CSV
                </button>
                <button onClick={() => window.print()}
                  style={{ padding: '5px 12px', fontSize: 11, fontWeight: 700, background: 'transparent', border: `1px solid ${ACCENT}`, borderRadius: 3, color: ACCENT, cursor: 'pointer' }}
                  className="no-print">
                  ⎙ Print / PDF
                </button>
              </>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {!audit && !loading && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>No completed audits yet.</div>
          )}

          {audit && (
            <>
              {/* Audit meta */}
              <div className="glass" style={{ borderRadius: 8, padding: '14px 16px', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{audit.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {audit.started_at?.slice(0, 19).replace('T', ' ')} → {audit.completed_at?.slice(0, 19).replace('T', ' ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    {[
                      { label: 'Critical', value: audit.critical_count, color: CRIT },
                      { label: 'Warning', value: audit.warning_count, color: WARN },
                      { label: 'Info', value: audit.info_count, color: INFO },
                      { label: 'Total', value: audit.total_findings, color: ACCENT },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 20, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                        <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {commands.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {commands.map((c: string) => {
                      const col = CMD_COLORS[c] ?? '#A0AECF';
                      return (
                        <span key={c} style={{
                          fontSize: 9, padding: '2px 9px', borderRadius: 999, fontWeight: 700,
                          fontFamily: 'monospace',
                          background: `${col}22`,
                          border: `1px solid ${col}66`,
                          color: col,
                          boxShadow: `0 0 8px ${col}44`,
                        }}>{c}</span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Findings by severity */}
              {loading && <div style={{ color: 'var(--muted)', fontSize: 12, padding: 16 }}>Loading findings…</div>}
              {!loading && ['Critical', 'Warning', 'Info'].map(sev => {
                const group = bySev[sev] || [];
                if (group.length === 0) return null;
                return (
                  <div key={sev} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor(sev) }} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: sevColor(sev) }}>{sev}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>({group.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {group.map(f => (
                        <div key={f.id} className="glass" style={{ borderRadius: 6, padding: '8px 12px', borderLeft: `3px solid ${sevColor(sev)}` }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                            <span style={{ fontSize: 10, color: 'var(--muted)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 3, border: '1px solid var(--border)' }}>{f.service}</span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{f.category}</span>
                            {f.resource && <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 'auto', fontFamily: 'monospace' }}>{f.resource}</span>}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>{f.description}</div>
                          {f.recommendation && <div style={{ fontSize: 10, color: ACCENT, marginTop: 4 }}>→ {f.recommendation}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
