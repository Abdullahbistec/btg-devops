'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';

interface AuditSummary {
  id: string;
  name: string;
  completed_at: string;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
}

interface CompareEntry {
  subscription: { id: string; name: string; is_active: number };
  latestAudit: AuditSummary | null;
  byService: { service: string; count: number }[];
}

const CRIT = '#FF4757';
const WARN = '#FFA502';
const INFO = '#54A0FF';
const ACCENT = '#00C2FF';

export default function ComparePage() {
  const [entries, setEntries] = useState<CompareEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/subscriptions/compare')
      .then(r => r.json())
      .then((data: CompareEntry[]) => {
        const list = Array.isArray(data) ? data : [];
        setEntries(list);
        setSelected(new Set(list.map(e => e.subscription.id)));
        setLoading(false);
      });
  }, []);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const visible = entries.filter(e => selected.has(e.subscription.id));

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Topbar */}
        <div className="glass-sb" style={{ borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Compare Subscriptions</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>Side-by-side view of each subscription&apos;s latest audit</div>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>

          {/* Subscription picker */}
          <div className="glass-sb" style={{ width: 200, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '12px 10px', overflowY: 'auto' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Subscriptions</div>
            {loading && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading…</div>}
            {!loading && entries.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted)' }}>No subscriptions found.</div>}
            {entries.map(e => (
              <label key={e.subscription.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 4px', fontSize: 11, color: 'var(--text)', cursor: 'pointer' }}>
                <input type="checkbox" checked={selected.has(e.subscription.id)} onChange={() => toggle(e.subscription.id)} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subscription.name}</span>
              </label>
            ))}
          </div>

          {/* Comparison columns */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {!loading && visible.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 40, fontSize: 13 }}>
                Select at least one subscription to compare.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, visible.length)}, minmax(260px, 1fr))`, gap: 12 }}>
              {visible.map(e => (
                <div key={e.subscription.id} className="glass" style={{ borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{e.subscription.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                      {e.latestAudit
                        ? `${e.latestAudit.name} · ${e.latestAudit.completed_at?.slice(0, 16).replace('T', ' ')}`
                        : 'No completed audits yet'}
                    </div>
                  </div>

                  {e.latestAudit ? (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                        {[
                          ['Total', e.latestAudit.total_findings, ACCENT],
                          ['Critical', e.latestAudit.critical_count, CRIT],
                          ['Warning', e.latestAudit.warning_count, WARN],
                          ['Info', e.latestAudit.info_count, INFO],
                        ].map(([label, value, color]) => (
                          <div key={label as string} style={{ textAlign: 'center', background: 'var(--card2)', borderRadius: 6, padding: '8px 4px' }}>
                            <div style={{ fontSize: 18, fontWeight: 800, color: color as string, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                            <div style={{ fontSize: 8.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
                          </div>
                        ))}
                      </div>

                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>By Service</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {e.byService.length === 0 && <div style={{ fontSize: 10, color: 'var(--muted)' }}>No findings</div>}
                          {e.byService.map(s => (
                            <div key={s.service}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
                                <span style={{ color: 'var(--text)' }}>{s.service}</span>
                                <span style={{ color: ACCENT, fontWeight: 700 }}>{s.count}</span>
                              </div>
                              <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                                <div style={{ height: '100%', width: `${Math.min(100, (s.count / (e.latestAudit!.total_findings || 1)) * 100)}%`, background: ACCENT, borderRadius: 2 }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <a href={`/dashboard?audit_id=${e.latestAudit.id}`} style={{
                        textAlign: 'center', padding: '6px 0', fontSize: 10.5, fontWeight: 700,
                        background: 'var(--accent)', color: '#fff', borderRadius: 4, textDecoration: 'none',
                      }}>
                        View in Dashboard →
                      </a>
                    </>
                  ) : (
                    <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: '20px 0' }}>
                      Run an audit for this subscription to see data here.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
