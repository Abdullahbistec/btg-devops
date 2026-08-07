'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';

interface Audit {
  id: string;
  name: string;
  status: string;
  started_at: string;
  finished_at: string;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  subscription_id: string;
  current_step?: string;
  total_steps?: number;
  completed_steps?: number;
  commands_run?: string;
}

const AZURE_COMMANDS = [
  'appservice-traffic', 'storage', 'nsg', 'acr', 'cosmosdb', 'keyvault',
  'functions', 'publicip', 'appserviceplan', 'cognitiveservices', 'resourcegroup',
  'iam', 'sp-expiry',
];
const PP_COMMANDS = ['powerplatform', 'pp-environments', 'pp-apps', 'pp-flows', 'pp-powerbi'];

const STATUS_COLOR: Record<string, string> = {
  completed: '#2ED573',
  running:   '#FFA502',
  failed:    '#FF4757',
  pending:   '#5B6FA8',
};

const AUDIT_STEPS = [
  { label: 'App Service',       key: 'appservice-traffic', color: '#00C2FF' },
  { label: 'Storage',           key: 'storage',            color: '#FFA502' },
  { label: 'NSG',               key: 'nsg',                color: '#FF4757' },
  { label: 'ACR',               key: 'acr',                color: '#7B5EA7' },
  { label: 'Cosmos DB',         key: 'cosmosdb',           color: '#2ED573' },
  { label: 'Key Vault',         key: 'keyvault',           color: '#FFD166' },
  { label: 'Functions',         key: 'functions',          color: '#FF6B9D' },
  { label: 'Public IP',         key: 'publicip',           color: '#54A0FF' },
  { label: 'App Svc Plan',      key: 'appserviceplan',     color: '#00B894' },
  { label: 'Cognitive Svc',     key: 'cognitiveservices',  color: '#A29BFE' },
  { label: 'Resource Group',    key: 'resourcegroup',      color: '#FD79A8' },
  { label: 'IAM',               key: 'iam',                color: '#E17055' },
  { label: 'SP Expiry',         key: 'sp-expiry',          color: '#FDCB6E' },
  { label: 'Power Platform',    key: 'powerplatform',      color: '#00CEC9' },
  { label: 'PP Environments',   key: 'pp-environments',    color: '#6C5CE7' },
  { label: 'PP Apps',           key: 'pp-apps',            color: '#55EFC4' },
  { label: 'PP Flows',          key: 'pp-flows',           color: '#74B9FF' },
  { label: 'Power BI',          key: 'pp-powerbi',         color: '#F9CA24' },
];

function AuditProgressBar({ audit }: { audit: Audit | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!audit?.started_at) return;
    const start = new Date(audit.started_at.replace(' ', 'T') + 'Z').getTime();
    const timer = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [audit?.started_at]);

  const totalSteps = audit?.total_steps || 0;
  const completedSteps = audit?.completed_steps || 0;
  const currentStepKey = audit?.current_step || '';
  const pct = totalSteps > 0 ? Math.min(100, Math.round((completedSteps / totalSteps) * 100)) : 0;
  const lastLabel = AUDIT_STEPS.find(s => s.key === currentStepKey)?.label || currentStepKey;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  // The real, planned command list for this specific run (stored at audit creation
  // time), not a hardcoded superset — so an Azure-only or PP-only scan only shows
  // its own steps.
  let plannedCommands: string[] = [];
  try { plannedCommands = JSON.parse(audit?.commands_run || '[]'); } catch { /* ignore */ }
  const runSteps = plannedCommands
    .map(key => AUDIT_STEPS.find(s => s.key === key))
    .filter((s): s is typeof AUDIT_STEPS[number] => !!s);

  return (
    <div style={{ background: '#FFA50210', borderBottom: '1px solid #FFA50230', padding: '10px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: '#FFA502', fontWeight: 700 }}>
          ⟳ {completedSteps > 0 ? `Last completed: ${lastLabel}` : 'Starting…'}
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
          {mm}:{ss} elapsed · {completedSteps}/{totalSteps || '?'} steps · {pct}%
        </div>
      </div>
      {/* Progress bar — driven by real completed-step count from the backend, not a timer */}
      <div style={{ height: 4, background: 'rgba(255,165,2,0.15)', borderRadius: 2, overflow: 'hidden', marginBottom: runSteps.length ? 6 : 0 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#FFA502,#FFD166)', borderRadius: 2, transition: 'width 0.6s ease' }} />
      </div>
      {/* Step chips — only the commands actually planned for this run */}
      {runSteps.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {runSteps.map((s) => {
            const idx = plannedCommands.indexOf(s.key);
            const c = s.color;
            const stateDone = idx < completedSteps;
            const stateCurrent = s.key === currentStepKey && idx === completedSteps - 1;
            return (
              <span key={s.key} style={{
                fontSize: 9, padding: '2px 8px', borderRadius: 999, fontWeight: 700,
                background: stateDone ? `${c}33` : `${c}12`,
                border: `1px solid ${stateDone ? (stateCurrent ? c : `${c}99`) : `${c}44`}`,
                color: stateDone ? (stateCurrent ? c : '#2ED573') : `${c}99`,
                boxShadow: stateCurrent ? `0 0 10px ${c}55, 0 0 3px ${c}33` : 'none',
                transition: 'all 0.3s ease',
              }}>
                {stateDone ? (stateCurrent ? '⟳ ' : '✓ ') : ''}{s.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AuditCard({ a, selected, onSelect }: { a: Audit; selected: boolean; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  const sc = STATUS_COLOR[a.status] ?? '#888';

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="glass"
      style={{
        borderRadius: 8,
        padding: '8px 14px',
        cursor: 'pointer',
        transition: 'background 0.15s, box-shadow 0.15s, border-color 0.15s',
        background: hovered
          ? 'rgba(0,194,255,0.07)'
          : selected
          ? 'rgba(0,194,255,0.04)'
          : undefined,
        boxShadow: hovered
          ? '0 0 0 1px rgba(0,194,255,0.25), 0 4px 24px rgba(0,0,0,0.3)'
          : undefined,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto auto', gap: 14, alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)', marginBottom: 2 }}>
            {a.name || `Audit ${a.id.slice(0, 8)}`}
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
            {a.started_at?.slice(0, 19).replace('T', ' ')}
            {a.finished_at ? ` → ${a.finished_at?.slice(11, 16)}` : ''}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#FF4757', fontVariantNumeric: 'tabular-nums' }}>{a.critical_count} crit</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{a.warning_count} warn</div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{a.total_findings}</div>
          <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>findings</div>
        </div>

        <div style={{
          padding: '2px 9px', borderRadius: 3, fontSize: 10, fontWeight: 700,
          color: sc, background: `${sc}1A`, border: `1px solid ${sc}40`,
        }}>
          {a.status}
        </div>

        {/* View Dashboard — fades in on hover, no extra height */}
        <a
          href={`/dashboard?audit_id=${a.id}`}
          onClick={e => e.stopPropagation()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '4px 12px', borderRadius: 4, fontSize: 10, fontWeight: 700,
            background: hovered ? 'linear-gradient(135deg,#00C2FF,#0094CC)' : 'transparent',
            border: `1px solid ${hovered ? '#00C2FF' : 'transparent'}`,
            color: hovered ? '#fff' : 'transparent',
            boxShadow: hovered ? '0 2px 10px rgba(0,194,255,0.3)' : 'none',
            textDecoration: 'none',
            transition: 'all 0.15s',
            pointerEvents: hovered ? 'auto' : 'none',
            whiteSpace: 'nowrap',
          }}
        >
          View Dashboard →
        </a>
      </div>
    </div>
  );
}

export default function AuditsPage() {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pollingId, setPollingId] = useState<string | null>(null);
  const [polledAudit, setPolledAudit] = useState<Audit | null>(null);
  const [isAdmin, setIsAdmin] = useState(true);
  const [subscriptions, setSubscriptions] = useState<{ id: string; name: string; is_active: number }[]>([]);
  const [selectedSub, setSelectedSub] = useState<string>('');

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => {
      if (d) setIsAdmin(d.role === 'admin');
    });
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    fetch('/api/subscriptions').then(r => r.ok ? r.json() : []).then(list => {
      const subs = Array.isArray(list) ? list : [];
      setSubscriptions(subs);
      const active = subs.find((s: { is_active: number }) => s.is_active) ?? subs[0];
      if (active) setSelectedSub(active.id);
    });
  }, [isAdmin]);

  async function load() {
    setLoading(true);
    const r = await fetch('/api/audits');
    const data = await r.json();
    setAudits(Array.isArray(data) ? data : []);
    setLoading(false);
  }

  async function runAudit(commands?: string[], name?: string) {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch('/api/audits/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(commands ? { commands } : {}),
          ...(name ? { name } : {}),
          ...(selectedSub ? { subscription_id: selectedSub } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunError(data.error || 'Failed to start audit');
        setRunning(false);
        return;
      }
      // Poll until the audit leaves 'running' state
      const id = data.audit_id;
      setPollingId(id);
      const poll = setInterval(async () => {
        await load();
        const r2 = await fetch('/api/audits');
        const list: Audit[] = await r2.json();
        const a = list.find(x => x.id === id);
        setPolledAudit(a ?? null);
        if (!a || a.status !== 'running') {
          clearInterval(poll);
          setRunning(false);
          setPollingId(null);
          setPolledAudit(null);
        }
      }, 2000);
    } catch (e) {
      setRunError((e as Error).message);
      setRunning(false);
    }
  }

  useEffect(() => { load(); }, []);

  const sel = audits.find(a => a.id === selected);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Topbar */}
        <div className="glass-sb" style={{ borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Audit History</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{audits.length} audit{audits.length !== 1 ? 's' : ''} on record</div>
          </div>
          {isAdmin ? (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {subscriptions.length > 1 && (
                <select value={selectedSub} onChange={e => setSelectedSub(e.target.value)} disabled={running}
                  title="Which subscription to scan"
                  style={{ fontSize: 11, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '5px 8px' }}>
                  {subscriptions.map(s => (
                    <option key={s.id} value={s.id}>{s.name}{!s.is_active ? ' (inactive)' : ''}</option>
                  ))}
                </select>
              )}
              <button onClick={() => runAudit(AZURE_COMMANDS, `Azure Scan ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`)} disabled={running} style={{
                padding: '5px 14px', fontSize: 11, fontWeight: 700,
                background: 'transparent', border: '1px solid #00C2FF', borderRadius: 3, color: '#00C2FF',
                opacity: running ? 0.5 : 1, cursor: running ? 'not-allowed' : 'pointer',
              }}>
                {running ? '⟳ Running…' : '▶ Run Azure Scan'}
              </button>
              <button onClick={() => runAudit(PP_COMMANDS, `Power Platform Scan ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`)} disabled={running} style={{
                padding: '5px 14px', fontSize: 11, fontWeight: 700,
                background: 'transparent', border: '1px solid #00CEC9', borderRadius: 3, color: '#00CEC9',
                opacity: running ? 0.5 : 1, cursor: running ? 'not-allowed' : 'pointer',
              }}>
                {running ? '⟳ Running…' : '▶ Run Power Platform Scan'}
              </button>
              <button onClick={() => runAudit()} disabled={running} style={{
                padding: '5px 14px', fontSize: 11, fontWeight: 700,
                background: running ? 'transparent' : 'var(--accent)',
                border: '1px solid var(--accent)', borderRadius: 3, color: running ? 'var(--accent)' : '#fff',
                opacity: running ? 0.7 : 1,
              }}>
                {running ? '⟳ Running…' : '▶ Run Full Audit'}
              </button>
            </div>
          ) : (
            <span title="Viewers cannot trigger scans — contact an admin" style={{
              marginLeft: 'auto', padding: '5px 14px', fontSize: 11, fontWeight: 700,
              border: '1px solid var(--border)', borderRadius: 3, color: 'var(--muted)', cursor: 'not-allowed',
            }}>
              🔒 Run New Audit
            </span>
          )}
        </div>

        {runError && (
          <div style={{ background: '#FF475718', borderBottom: '1px solid #FF475740', padding: '6px 16px', fontSize: 11, color: '#FF4757', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>⚠ {runError}</span>
            <button onClick={() => setRunError(null)} style={{ background: 'none', border: 'none', color: '#FF4757', cursor: 'pointer', fontSize: 13 }}>✕</button>
          </div>
        )}
        {running && pollingId && (
          <AuditProgressBar audit={polledAudit} />
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>

          {/* Audit list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
            {loading && <div style={{ color: 'var(--muted)', padding: 20, fontSize: 12 }}>Loading…</div>}
            {!loading && audits.length === 0 && (
              <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                No audits yet. Click <strong>Run New Audit</strong> to scan your Azure environment.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {audits.map(a => <AuditCard key={a.id} a={a} selected={selected === a.id} onSelect={() => setSelected(selected === a.id ? null : a.id)} />)}
            </div>
          </div>

          {/* Detail panel */}
          {sel && (
            <div className="glass-sb" style={{ width: 280, borderLeft: '1px solid var(--border)', overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{sel.name || 'Audit Detail'}</div>
                <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 14, cursor: 'pointer' }}>✕</button>
              </div>

              <div style={{ height: 1, background: 'var(--border)' }} />

              {[
                ['ID', sel.id.slice(0, 12) + '…'],
                ['Status', sel.status],
                ['Started', sel.started_at?.slice(0, 19).replace('T', ' ')],
                ['Finished', sel.finished_at?.slice(0, 19).replace('T', ' ') || 'In progress…'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: 'var(--muted)' }}>{k}</span>
                  <span style={{ color: 'var(--text)', fontWeight: 500 }}>{v}</span>
                </div>
              ))}

              <div style={{ height: 1, background: 'var(--border)' }} />
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Findings Summary</div>

              {[
                ['Critical', sel.critical_count, '#FF4757'],
                ['Warning', sel.warning_count, '#FFA502'],
                ['Info', sel.info_count, '#54A0FF'],
                ['Total', sel.total_findings, '#00C2FF'],
              ].map(([k, v, c]) => (
                <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                  <span style={{ color: 'var(--muted)' }}>{k}</span>
                  <span style={{ color: c as string, fontWeight: 800, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
                </div>
              ))}

              <div style={{ height: 1, background: 'var(--border)' }} />
              <a href={`/dashboard?audit_id=${sel.id}`} style={{
                display: 'block', textAlign: 'center', padding: '7px 0', fontSize: 11, fontWeight: 700,
                background: 'var(--accent)', color: '#fff', borderRadius: 3,
              }}>
                View in Dashboard →
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
