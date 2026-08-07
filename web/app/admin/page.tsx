'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string; email: string; name: string;
  role: string; status: string; created_at: string; approved_at: string | null;
}

interface Stats {
  users: { total: number; pending: number; active: number; rejected: number; inactive: number };
  audits: { total: number; completed: number; failed: number; running: number };
  findings: { total: number; critical: number; warning: number; info: number };
  subscriptions: number;
  recentAudits: {
    id: string; name: string; status: string; started_at: string; completed_at: string;
    total_findings: number; critical_count: number; warning_count: number; info_count: number; resources_scanned: number;
  }[];
  envChecks: { smtp: boolean; azureCreds: boolean; adminEmail: boolean; sessionSecret: boolean; ppCreds: boolean };
}

const STATUS_COLOR: Record<string, string> = {
  active: '#2ED573', pending: '#FFA502', rejected: '#FF4757', inactive: '#5B6FA8',
};
const AUDIT_STATUS_COLOR: Record<string, string> = {
  completed: '#2ED573', running: '#00C2FF', failed: '#FF4757', pending: '#FFA502',
};

function fmt(dt: string | null) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function useHover() {
  const [h, setH] = useState(false);
  return { h, onMouseEnter: () => setH(true), onMouseLeave: () => setH(false) };
}

function ActionBtn({ label, color, onClick, small }: { label: string; color: string; onClick: () => void; small?: boolean }) {
  const { h, ...hProps } = useHover();
  return (
    <button onClick={onClick} {...hProps} style={{
      background: h ? `${color}25` : `${color}10`,
      border: `1px solid ${color}55`, color,
      borderRadius: 6, fontSize: small ? 10 : 11, fontWeight: 700,
      padding: small ? '3px 9px' : '5px 12px',
      cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>{label}</button>
  );
}

function NavItem({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: number; onClick: () => void }) {
  const { h, ...hProps } = useHover();
  return (
    <button onClick={onClick} {...hProps} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
      padding: '9px 16px', borderRadius: 8, fontSize: 12, fontWeight: active ? 700 : 500,
      background: active ? 'rgba(255,165,2,0.12)' : h ? 'rgba(255,255,255,0.05)' : 'transparent',
      border: active ? '1px solid rgba(255,165,2,0.35)' : '1px solid transparent',
      color: active ? '#FFA502' : h ? '#E8ECF8' : '#8A9CC0',
      cursor: 'pointer', transition: 'all 0.15s', textAlign: 'left',
      boxShadow: active ? '0 0 12px rgba(255,165,2,0.12)' : 'none',
    }}>
      <span style={{ opacity: active ? 1 : 0.7 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span style={{ background: '#FF4757', color: '#fff', borderRadius: 999, fontSize: 9, fontWeight: 900, padding: '1px 6px', minWidth: 16, textAlign: 'center' }}>
          {badge}
        </span>
      )}
    </button>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'requests' | 'users' | 'audits' | 'system'>('requests');
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [adminName, setAdminName] = useState('Admin');
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailSubject, setEmailSubject] = useState('BTG DevOps — Security Update');
  const [emailMessage, setEmailMessage] = useState('');
  const [emailRecipients, setEmailRecipients] = useState<'all' | 'active'>('active');
  const [emailSending, setEmailSending] = useState(false);
  const [emailResult, setEmailResult] = useState('');

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }

  const loadAll = useCallback(async () => {
    // Check admin access
    const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null);
    if (!me || me.role !== 'admin') { router.replace('/dashboard'); return; }
    setAdminName(me.name || me.email?.split('@')[0] || 'Admin');

    const [statsRes, usersRes] = await Promise.all([
      fetch('/api/admin/stats'),
      fetch('/api/admin/users'),
    ]);
    if (statsRes.ok) setStats(await statsRes.json());
    if (usersRes.ok) setUsers(await usersRes.json());
    setLoading(false);
  }, [router]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function patchUser(id: string, patch: { status?: string; role?: string }) {
    const r = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    if (r.ok) { showToast('✓ Saved'); await loadAll(); }
    else showToast('✗ Error');
  }

  async function sendEmail() {
    setEmailSending(true);
    setEmailResult('');
    const r = await fetch('/api/admin/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: emailSubject, message: emailMessage, recipients: emailRecipients }),
    });
    const data = await r.json();
    setEmailSending(false);
    if (data.devMode) setEmailResult(`Dev mode: would send to ${data.sent} user(s). Configure SMTP to send real emails.`);
    else if (data.ok) setEmailResult(`Sent to ${data.sent}/${data.total} user(s).`);
    else setEmailResult(`Error: ${data.error}`);
  }

  async function removeUser(id: string, email: string) {
    if (!confirm(`Delete ${email}? This cannot be undone.`)) return;
    await fetch(`/api/admin/users?id=${id}`, { method: 'DELETE' });
    showToast('User deleted');
    await loadAll();
  }

  const pending = users.filter(u => u.status === 'pending');

  if (loading) return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#060A1A', color: '#5B6FA8', fontSize: 13, fontFamily: "'Segoe UI', sans-serif" }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 32, height: 32, border: '2px solid rgba(255,165,2,0.3)', borderTopColor: '#FFA502', borderRadius: '50%', margin: '0 auto 12px', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        Loading admin panel…
      </div>
    </div>
  );

  return (
    <>
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Segoe UI', sans-serif", background: '#060A1A', overflow: 'hidden' }}>

      {/* ── Admin Sidebar ── */}
      <aside style={{
        width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column',
        background: 'rgba(10,14,35,0.95)',
        borderRight: '1px solid rgba(255,165,2,0.12)',
        boxShadow: '4px 0 24px rgba(0,0,0,0.4)',
      }}>
        {/* Logo */}
        <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid rgba(255,165,2,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(255,165,2,0.12)', border: '1.5px solid rgba(255,165,2,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5L2 4.5v4.5c0 3 2.5 5 6 6 3.5-1 6-3 6-6V4.5L8 1.5z" fill="rgba(255,165,2,0.2)" stroke="#FFA502" strokeWidth="1.2"/><path d="M5.5 8l2 2 3-3" stroke="#FFA502" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#FFA502', letterSpacing: '-0.01em' }}>Admin Panel</div>
              <div style={{ fontSize: 9, color: '#5B6FA8', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 1 }}>BTG DevOps</div>
            </div>
          </div>
        </div>

        {/* Pending alert */}
        {pending.length > 0 && (
          <div style={{ margin: '12px 12px 0', padding: '8px 12px', borderRadius: 8, background: 'rgba(255,71,87,0.08)', border: '1px solid rgba(255,71,87,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#FF4757', flexShrink: 0, boxShadow: '0 0 6px #FF4757' }} />
            <span style={{ fontSize: 11, color: '#FF4757', fontWeight: 700 }}>{pending.length} request{pending.length > 1 ? 's' : ''} pending</span>
          </div>
        )}

        {/* Nav */}
        <nav style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <NavItem icon={<BellIcon />}   label="Access Requests" active={tab === 'requests'} badge={pending.length} onClick={() => setTab('requests')} />
          <NavItem icon={<UsersIcon />}  label="Manage Users"    active={tab === 'users'}    onClick={() => setTab('users')} />
          <NavItem icon={<AuditIcon />}  label="Audit History"   active={tab === 'audits'}   onClick={() => setTab('audits')} />
          <NavItem icon={<SystemIcon />} label="System"          active={tab === 'system'}   onClick={() => setTab('system')} />
        </nav>

        {/* Stats summary */}
        {stats && (
          <div style={{ margin: '0 12px 12px', padding: '12px', borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {[
              { label: 'Total Users',    value: stats.users.total,          color: '#E8ECF8' },
              { label: 'Active',         value: stats.users.active,         color: '#2ED573' },
              { label: 'Total Audits',   value: stats.audits.completed,     color: '#00C2FF' },
              { label: 'Total Findings', value: stats.findings.total,       color: '#FFA502' },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ fontSize: 10, color: '#5B6FA8' }}>{row.label}</span>
                <span style={{ fontSize: 11, fontWeight: 800, color: row.color }}>{row.value}</span>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: 10, color: '#5B6FA8', marginBottom: 6 }}>Signed in as</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#FFA502', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{adminName}</div>
          <button
            onClick={() => router.push('/dashboard')}
            style={{ width: '100%', padding: '6px 0', borderRadius: 7, fontSize: 10, fontWeight: 700, background: 'rgba(0,194,255,0.08)', border: '1px solid rgba(0,194,255,0.2)', color: '#00C2FF', cursor: 'pointer', marginBottom: 6 }}>
            ← Main Dashboard
          </button>
          <button
            onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.push('/login'); }}
            style={{ width: '100%', padding: '6px 0', borderRadius: 7, fontSize: 10, fontWeight: 700, background: 'rgba(255,71,87,0.08)', border: '1px solid rgba(255,71,87,0.2)', color: '#FF4757', cursor: 'pointer' }}>
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Main Content ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Top bar */}
        <header style={{ padding: '14px 24px', borderBottom: '1px solid rgba(255,165,2,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, background: 'rgba(6,10,26,0.8)', flexShrink: 0, flexWrap: 'nowrap' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: '#E8ECF8', letterSpacing: '-0.02em' }}>
              {tab === 'requests' && 'Access Requests'}
              {tab === 'users'    && 'User Management'}
              {tab === 'audits'   && 'Audit History'}
              {tab === 'system'   && 'System Health'}
            </div>
            <div style={{ fontSize: 10, color: '#5B6FA8', marginTop: 2 }}>
              {tab === 'requests' && 'Approve or reject pending registration requests'}
              {tab === 'users'    && 'Activate, deactivate, promote or remove users'}
              {tab === 'audits'   && 'Full history of all Azure and Power Platform audits'}
              {tab === 'system'   && 'Environment configuration and platform health'}
            </div>
          </div>

          {/* Stats chips */}
          {stats && (
            <div style={{ display: 'flex', gap: 10 }}>
              {[
                { label: 'Pending', value: stats.users.pending, color: '#FFA502' },
                { label: 'Active Users', value: stats.users.active, color: '#2ED573' },
                { label: 'Critical Findings', value: stats.findings.critical, color: '#FF4757' },
              ].map(c => (
                <div key={c.label} style={{ textAlign: 'center', padding: '6px 14px', borderRadius: 8, background: `${c.color}0D`, border: `1px solid ${c.color}30` }}>
                  <div style={{ fontSize: 16, fontWeight: 900, color: c.color, lineHeight: 1 }}>{c.value}</div>
                  <div style={{ fontSize: 9, color: '#5B6FA8', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{c.label}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {/* Print button */}
            <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#C8D4F0', cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}><rect x="3" y="1" width="8" height="4" rx="1"/><rect x="3" y="8" width="8" height="5" rx="1"/><path d="M3 5v3h8V5"/><circle cx="11" cy="6.5" r="0.7" fill="currentColor" stroke="none"/></svg>
              Print / PDF
            </button>
            {/* Share via Email button */}
            <button onClick={() => { setShowEmailModal(true); setEmailResult(''); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: 'rgba(255,165,2,0.1)', border: '1px solid rgba(255,165,2,0.35)', color: '#FFA502', cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}><rect x="1" y="3" width="12" height="9" rx="1.5"/><path d="M1 5l6 4 6-4"/></svg>
              Share via Email
            </button>
            {toast && (
              <div style={{ padding: '7px 14px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: toast.startsWith('✓') ? 'rgba(46,213,115,0.12)' : 'rgba(255,71,87,0.12)', border: `1px solid ${toast.startsWith('✓') ? '#2ED57344' : '#FF475744'}`, color: toast.startsWith('✓') ? '#2ED573' : '#FF4757' }}>
                {toast}
              </div>
            )}
          </div>
        </header>

        {/* Content area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>

          {/* ── REQUESTS ── */}
          {tab === 'requests' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 780 }}>
              {pending.length === 0 ? (
                <div style={{ padding: '48px 32px', textAlign: 'center', borderRadius: 14, border: '1px dashed rgba(255,255,255,0.1)', color: '#5B6FA8', fontSize: 13 }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>✓</div>
                  No pending access requests
                </div>
              ) : pending.map(u => (
                <div key={u.id} style={{ padding: '18px 22px', borderRadius: 12, background: 'rgba(255,165,2,0.03)', border: '1px solid rgba(255,165,2,0.18)', display: 'flex', alignItems: 'center', gap: 18 }}>
                  <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(255,165,2,0.12)', border: '2px solid rgba(255,165,2,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 900, color: '#FFA502', flexShrink: 0 }}>
                    {(u.name || u.email).slice(0, 1).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#E8ECF8' }}>{u.name || '—'}</div>
                    <div style={{ fontSize: 12, color: '#8A9CC0', marginTop: 2 }}>{u.email}</div>
                    <div style={{ fontSize: 10, color: '#4A5A80', marginTop: 4 }}>Requested {fmt(u.created_at)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <ActionBtn label="✓ Approve" color="#2ED573" onClick={() => patchUser(u.id, { status: 'active' })} />
                    <ActionBtn label="✗ Reject"  color="#FF4757" onClick={() => patchUser(u.id, { status: 'rejected' })} />
                  </div>
                </div>
              ))}

              {/* Rejected/inactive users for re-review */}
              {users.filter(u => u.status === 'rejected').length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#5B6FA8', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 8 }}>Rejected</div>
                  {users.filter(u => u.status === 'rejected').map(u => (
                    <div key={u.id} style={{ padding: '14px 18px', borderRadius: 10, background: 'rgba(255,71,87,0.03)', border: '1px solid rgba(255,71,87,0.15)', display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(255,71,87,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: '#FF4757', flexShrink: 0 }}>
                        {(u.name || u.email).slice(0, 1).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#8A9CC0' }}>{u.name} — {u.email}</div>
                      </div>
                      <ActionBtn label="Reinstate" color="#FFA502" onClick={() => patchUser(u.id, { status: 'active' })} small />
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* ── USERS ── */}
          {tab === 'users' && (
            <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)' }}>
              {/* Header row */}
              <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 1fr 90px 90px 160px 200px', gap: 12, padding: '10px 18px', fontSize: 9, fontWeight: 700, color: '#4A5A80', textTransform: 'uppercase', letterSpacing: '0.1em', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span>#</span><span>Name</span><span>Email</span><span>Role</span><span>Status</span><span>Joined</span><span>Actions</span>
              </div>

              {users.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#5B6FA8', fontSize: 13 }}>No registered users</div>
              )}

              {users.map((u, i) => {
                const sc = STATUS_COLOR[u.status] ?? '#5B6FA8';
                const rc = u.role === 'admin' ? '#FFA502' : '#7B5EA7';
                return (
                  <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 1fr 90px 90px 160px 200px', gap: 12, padding: '13px 18px', alignItems: 'center', borderBottom: i < users.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', background: i % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${sc}18`, border: `1.5px solid ${sc}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: sc }}>
                      {(u.name || u.email).slice(0, 1).toUpperCase()}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#E8ECF8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name || '—'}</div>
                    <div style={{ fontSize: 11, color: '#8A9CC0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                    <span style={{ background: `${rc}18`, border: `1px solid ${rc}44`, color: rc, borderRadius: 999, fontSize: 9, fontWeight: 800, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap', textAlign: 'center' }}>{u.role}</span>
                    <span style={{ background: `${sc}18`, border: `1px solid ${sc}44`, color: sc, borderRadius: 999, fontSize: 9, fontWeight: 800, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap', textAlign: 'center' }}>{u.status}</span>
                    <div style={{ fontSize: 10, color: '#4A5A80' }}>{fmt(u.created_at)}</div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {u.status === 'pending'   && <ActionBtn label="Approve"    color="#2ED573" onClick={() => patchUser(u.id, { status: 'active' })}   small />}
                      {u.status === 'active'    && <ActionBtn label="Deactivate" color="#FFA502" onClick={() => patchUser(u.id, { status: 'inactive' })} small />}
                      {(u.status === 'inactive' || u.status === 'rejected') && <ActionBtn label="Activate" color="#2ED573" onClick={() => patchUser(u.id, { status: 'active' })} small />}
                      {u.role !== 'admin'  && <ActionBtn label="→ Admin"  color="#FFA502" onClick={() => patchUser(u.id, { role: 'admin' })}  small />}
                      {u.role === 'admin'  && <ActionBtn label="→ Viewer" color="#7B5EA7" onClick={() => patchUser(u.id, { role: 'viewer' })} small />}
                      <ActionBtn label="Delete" color="#FF4757" onClick={() => removeUser(u.id, u.email)} small />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── AUDITS ── */}
          {tab === 'audits' && (
            <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 80px 80px 80px 100px 120px', gap: 12, padding: '10px 18px', fontSize: 9, fontWeight: 700, color: '#4A5A80', textTransform: 'uppercase', letterSpacing: '0.1em', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span>Audit Name</span><span>Status</span><span>Findings</span><span>Critical</span><span>Warning</span><span>Resources</span><span>Started</span>
              </div>
              {(!stats?.recentAudits || stats.recentAudits.length === 0) && (
                <div style={{ padding: 40, textAlign: 'center', color: '#5B6FA8', fontSize: 13 }}>No audits yet</div>
              )}
              {stats?.recentAudits.map((a, i) => {
                const sc = AUDIT_STATUS_COLOR[a.status] ?? '#5B6FA8';
                return (
                  <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 80px 80px 80px 100px 120px', gap: 12, padding: '12px 18px', alignItems: 'center', borderBottom: i < stats.recentAudits.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', background: i % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#E8ECF8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                    <span style={{ background: `${sc}18`, border: `1px solid ${sc}44`, color: sc, borderRadius: 999, fontSize: 9, fontWeight: 800, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap', textAlign: 'center' }}>{a.status}</span>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#E8ECF8' }}>{a.total_findings || 0}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#FF4757' }}>{a.critical_count || 0}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#FFA502' }}>{a.warning_count || 0}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#2ED573' }}>{a.resources_scanned || '—'}</div>
                    <div style={{ fontSize: 10, color: '#4A5A80' }}>{fmt(a.started_at)}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── SYSTEM ── */}
          {tab === 'system' && stats && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 820 }}>

              {/* Env checks */}
              <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)' }}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 12, fontWeight: 800, color: '#E8ECF8' }}>
                  Environment Configuration
                </div>
                <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { label: 'Admin Email',           key: 'adminEmail',    ok: stats.envChecks.adminEmail },
                    { label: 'Session Secret',         key: 'sessionSecret', ok: stats.envChecks.sessionSecret },
                    { label: 'Azure Credentials',      key: 'azureCreds',    ok: stats.envChecks.azureCreds },
                    { label: 'SMTP Email',             key: 'smtp',          ok: stats.envChecks.smtp },
                    { label: 'Power Platform Creds',   key: 'ppCreds',       ok: stats.envChecks.ppCreds },
                  ].map(({ label, key, ok }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderRadius: 9, background: ok ? 'rgba(46,213,115,0.04)' : 'rgba(255,71,87,0.04)', border: `1px solid ${ok ? 'rgba(46,213,115,0.15)' : 'rgba(255,71,87,0.12)'}` }}>
                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: ok ? 'rgba(46,213,115,0.15)' : 'rgba(255,71,87,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: 12, color: ok ? '#2ED573' : '#FF4757', fontWeight: 900 }}>{ok ? '✓' : '✗'}</span>
                      </div>
                      <span style={{ fontSize: 12, color: ok ? '#C8D4F0' : '#8A9CC0', flex: 1 }}>{label}</span>
                      <span style={{ fontSize: 10, fontWeight: 800, color: ok ? '#2ED573' : '#FF4757' }}>{ok ? 'Configured' : 'Not set'}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Two-column stats */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)' }}>
                  <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 12, fontWeight: 800, color: '#E8ECF8' }}>User Summary</div>
                  <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {[
                      { label: 'Total registered', value: stats.users.total,    color: '#E8ECF8' },
                      { label: 'Active',            value: stats.users.active,   color: '#2ED573' },
                      { label: 'Pending approval',  value: stats.users.pending,  color: '#FFA502' },
                      { label: 'Rejected',          value: stats.users.rejected, color: '#FF4757' },
                      { label: 'Deactivated',       value: stats.users.inactive ?? 0, color: '#5B6FA8' },
                    ].map((row, i, arr) => (
                      <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                        <span style={{ fontSize: 12, color: '#8A9CC0' }}>{row.label}</span>
                        <span style={{ fontSize: 16, fontWeight: 900, color: row.color }}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)' }}>
                  <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 12, fontWeight: 800, color: '#E8ECF8' }}>Audit & Findings</div>
                  <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {[
                      { label: 'Total audits',   value: stats.audits.total,      color: '#E8ECF8' },
                      { label: 'Completed',      value: stats.audits.completed,  color: '#2ED573' },
                      { label: 'Failed',         value: stats.audits.failed,     color: '#FF4757' },
                      { label: 'Total findings', value: stats.findings.total,    color: '#FFA502' },
                      { label: 'Critical',       value: stats.findings.critical, color: '#FF4757' },
                    ].map((row, i, arr) => (
                      <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                        <span style={{ fontSize: 12, color: '#8A9CC0' }}>{row.label}</span>
                        <span style={{ fontSize: 16, fontWeight: 900, color: row.color }}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>

    {/* Email Modal */}
    {showEmailModal && (
      <EmailModal
        users={users}
        subject={emailSubject} setSubject={setEmailSubject}
        message={emailMessage} setMessage={setEmailMessage}
        recipients={emailRecipients} setRecipients={setEmailRecipients}
        sending={emailSending} result={emailResult}
        onSend={sendEmail}
        onClose={() => { setShowEmailModal(false); setEmailResult(''); }}
      />
    )}
    </>
  );
}

/* ── Email Modal ── */
function EmailModal({ users, subject, setSubject, message, setMessage, recipients, setRecipients, sending, result, onSend, onClose }: {
  users: { email: string; status: string }[];
  subject: string; setSubject: (v: string) => void;
  message: string; setMessage: (v: string) => void;
  recipients: 'all' | 'active'; setRecipients: (v: 'all' | 'active') => void;
  sending: boolean; result: string;
  onSend: () => void; onClose: () => void;
}) {
  const activeCount = users.filter(u => u.status === 'active').length;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#0D1130', border: '1px solid rgba(255,165,2,0.25)', borderRadius: 16, padding: '28px 32px', width: 500, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: '#E8ECF8' }}>Share via Email</div>
            <div style={{ fontSize: 11, color: '#5B6FA8', marginTop: 3 }}>Send a message to dashboard users</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#8A9CC0', borderRadius: 6, width: 28, height: 28, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {/* Recipients */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#5B6FA8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Recipients</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['active', 'all'] as const).map(r => (
              <button key={r} onClick={() => setRecipients(r)} style={{ flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer', background: recipients === r ? 'rgba(255,165,2,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${recipients === r ? 'rgba(255,165,2,0.4)' : 'rgba(255,255,255,0.1)'}`, color: recipients === r ? '#FFA502' : '#8A9CC0' }}>
                {r === 'active' ? `Active Users (${activeCount})` : `All Users (${users.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* Subject */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#5B6FA8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Subject</div>
          <input value={subject} onChange={e => setSubject(e.target.value)} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF8', fontSize: 12, outline: 'none', fontFamily: 'inherit' }} />
        </div>

        {/* Message */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#5B6FA8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Message</div>
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={5} placeholder="Type your message here..." style={{ width: '100%', padding: '9px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF8', fontSize: 12, outline: 'none', fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        {/* Quick templates */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#5B6FA8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Quick Templates</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { label: 'Dashboard Link', msg: 'Hi,\n\nYour BTG DevOps Security Dashboard is ready:\nhttp://localhost:3000/dashboard\n\nSign in with your registered email and password.\n\nRegards,\nBTG DevOps Admin' },
              { label: 'New Audit Done', msg: 'Hi,\n\nA new security audit has been completed on the BTG DevOps platform. Please log in to review the latest findings:\nhttp://localhost:3000/dashboard\n\nRegards,\nBTG DevOps Admin' },
              { label: 'Account Approved', msg: 'Hi,\n\nYour access request has been approved. You can now sign in to the BTG DevOps Security Console:\nhttp://localhost:3000/login\n\nRegards,\nBTG DevOps Admin' },
            ].map(t => (
              <button key={t.label} onClick={() => setMessage(t.msg)} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,194,255,0.08)', border: '1px solid rgba(0,194,255,0.2)', color: '#00C2FF', cursor: 'pointer' }}>{t.label}</button>
            ))}
          </div>
        </div>

        {/* Result */}
        {result && (
          <div style={{ marginBottom: 14, padding: '9px 14px', borderRadius: 8, background: result.startsWith('Error') ? 'rgba(255,71,87,0.08)' : 'rgba(46,213,115,0.08)', border: `1px solid ${result.startsWith('Error') ? 'rgba(255,71,87,0.2)' : 'rgba(46,213,115,0.2)'}`, color: result.startsWith('Error') ? '#FF4757' : '#2ED573', fontSize: 12 }}>
            {result}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#8A9CC0', cursor: 'pointer' }}>Cancel</button>
          <button onClick={onSend} disabled={sending || !message.trim()} style={{ padding: '9px 24px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: sending ? 'rgba(255,165,2,0.3)' : 'rgba(255,165,2,0.15)', border: '1px solid rgba(255,165,2,0.4)', color: '#FFA502', cursor: sending ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 7, opacity: !message.trim() ? 0.5 : 1 }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="2.5" width="10" height="7.5" rx="1.5"/><path d="M1 4l5 3.5L11 4"/></svg>
            {sending ? 'Sending…' : 'Send Email'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BellIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 1.5a4 4 0 014 4v3l1 1.5H2L3 8.5v-3a4 4 0 014-4zM5.5 10.5a1.5 1.5 0 003 0"/></svg>;
}
function UsersIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="5.5" cy="5" r="2.5"/><path d="M1 12c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><circle cx="10.5" cy="4.5" r="2"/><path d="M12.5 11c0-1.5-1-2.5-2-3"/></svg>;
}
function AuditIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="10" height="10" rx="1.5"/><path d="M5 7l1.5 1.5L9 5"/></svg>;
}
function SystemIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="2"/><path d="M7 1.5v1.5M7 11v1.5M1.5 7H3M11 7h1.5M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1"/></svg>;
}
