'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';

interface DbUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: 'pending' | 'active' | 'rejected';
  created_at: string;
  approved_at: string | null;
}

interface ConfigStatus {
  tenantId: string;
  clientId: string;
  clientSecretSet: boolean;
  subscriptionId: string;
  ppClientId: string;
  ppTenantId: string;
  ppClientSecretSet: boolean;
  btgPath: string;
  dbPath: string;
}

interface Subscription {
  id: string;
  name: string;
  subscription_id: string;
  tenant_id: string;
  client_id: string;
  is_active: number;
}

interface Schedule {
  id: string;
  name: string;
  frequency: string;
  hour: number;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

const ACCENT = '#00C2FF';
const OK = '#2ED573';
const ERR = '#FF4757';

function mask(s: string) {
  if (!s || s === '—') return '—';
  if (s.length <= 8) return '••••••••';
  return s.slice(0, 4) + '••••••••' + s.slice(-4);
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: ok ? OK : ERR, marginRight: 5 }} />;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [users, setUsers] = useState<DbUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showAddSub, setShowAddSub] = useState(false);
  const [newSub, setNewSub] = useState({ name: '', subscription_id: '', tenant_id: '', client_id: '', client_secret: '' });
  const [addingSubError, setAddingSubError] = useState('');
  const [newSched, setNewSched] = useState({ name: 'Nightly Audit', frequency: 'daily', hour: '2' });
  const [addingSchedMsg, setAddingSchedMsg] = useState('');

  function loadUsers() {
    setUsersLoading(true);
    fetch('/api/auth/users')
      .then(r => r.json())
      .then(data => setUsers(Array.isArray(data) ? data : []))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false));
  }

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(setConfig)
      .catch(() => null);

    fetch('/api/subscriptions').then(r => r.json()).then(data => setSubs(Array.isArray(data) ? data : []));
    fetch('/api/schedule').then(r => r.json()).then(data => setSchedules(Array.isArray(data) ? data : []));
    loadUsers();
  }, []);

  async function patchUser(id: string, status: 'active' | 'rejected') {
    const res = await fetch('/api/auth/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    const label = status === 'active' ? 'approved' : 'rejected';
    setActionMsg({ id, ok: res.ok, text: res.ok ? `User ${label}` : 'Action failed' });
    if (res.ok) loadUsers();
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function removeUser(id: string) {
    const res = await fetch(`/api/auth/users?id=${id}`, { method: 'DELETE' });
    setActionMsg({ id, ok: res.ok, text: res.ok ? 'User removed' : 'Remove failed' });
    if (res.ok) loadUsers();
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function addSubscription() {
    setAddingSubError('');
    if (!newSub.name || !newSub.subscription_id || !newSub.tenant_id || !newSub.client_id) {
      setAddingSubError('Name, Subscription ID, Tenant ID, and Client ID are required.');
      return;
    }
    const res = await fetch('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSub),
    });
    if (res.ok) {
      setNewSub({ name: '', subscription_id: '', tenant_id: '', client_id: '', client_secret: '' });
      setShowAddSub(false);
      fetch('/api/subscriptions').then(r => r.json()).then(data => setSubs(Array.isArray(data) ? data : []));
    } else {
      const d = await res.json();
      setAddingSubError(d.error || 'Failed to add subscription');
    }
  }

  async function addSchedule() {
    setAddingSchedMsg('');
    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newSched.name, frequency: newSched.frequency, hour: parseInt(newSched.hour) }),
    });
    if (res.ok) {
      setAddingSchedMsg('Schedule created');
      fetch('/api/schedule').then(r => r.json()).then(data => setSchedules(Array.isArray(data) ? data : []));
    } else {
      setAddingSchedMsg('Failed to create schedule');
    }
    setTimeout(() => setAddingSchedMsg(''), 3000);
  }

  async function toggleSchedule(id: string, enabled: number) {
    await fetch('/api/schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled: enabled ? 0 : 1 }) });
    fetch('/api/schedule').then(r => r.json()).then(data => setSchedules(Array.isArray(data) ? data : []));
  }

  async function deleteSchedule(id: string) {
    await fetch(`/api/schedule?id=${id}`, { method: 'DELETE' });
    setSchedules(s => s.filter(x => x.id !== id));
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/test', { method: 'POST' });
      const data = await res.json();
      setTestResult({ ok: res.ok, message: data.message || (res.ok ? 'Connection successful' : 'Connection failed') });
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const rows = config ? [
    { label: 'Tenant ID', value: mask(config.tenantId), set: !!config.tenantId },
    { label: 'Client ID', value: mask(config.clientId), set: !!config.clientId },
    { label: 'Client Secret', value: config.clientSecretSet ? '••••••••••••' : '—', set: config.clientSecretSet },
    { label: 'Subscription ID', value: mask(config.subscriptionId), set: !!config.subscriptionId },
  ] : [];

  const ppRows = config ? [
    { label: 'PP Tenant ID', value: config.ppTenantId ? mask(config.ppTenantId) : '(uses AZURE_TENANT_ID)', set: true },
    { label: 'PP Client ID', value: config.ppClientId ? mask(config.ppClientId) : '(uses AZURE_CLIENT_ID)', set: true },
    { label: 'PP Client Secret', value: config.ppClientSecretSet ? '••••••••••••' : '(uses AZURE_CLIENT_SECRET)', set: true },
  ] : [];

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Topbar */}
        <div className="glass-sb" style={{ borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Settings</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>Configuration and connection status</div>
          </div>
          <button onClick={testConnection} disabled={testing} style={{
            marginLeft: 'auto', padding: '5px 14px', fontSize: 11, fontWeight: 700,
            background: testing ? 'transparent' : ACCENT,
            border: `1px solid ${ACCENT}`, borderRadius: 3,
            color: testing ? ACCENT : '#000', cursor: 'pointer', opacity: testing ? 0.7 : 1,
          }}>
            {testing ? '⟳ Testing…' : 'Test Connection'}
          </button>
        </div>

        {testResult && (
          <div style={{
            borderBottom: `1px solid ${testResult.ok ? OK : ERR}40`,
            background: `${testResult.ok ? OK : ERR}18`,
            padding: '6px 16px', fontSize: 11,
            color: testResult.ok ? OK : ERR,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{testResult.ok ? '✓' : '✗'} {testResult.message}</span>
            <button onClick={() => setTestResult(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13 }}>✕</button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Azure credentials */}
          <Section title="Azure Credentials" subtitle="Set via .env.local — AZURE_* variables">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {rows.map(({ label, value, set }) => (
                  <tr key={label} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 0', fontSize: 11, color: 'var(--muted)', width: 180 }}>
                      <StatusDot ok={set} />{label}
                    </td>
                    <td style={{ padding: '8px 0', fontSize: 11, color: 'var(--text)', fontFamily: 'monospace' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* Power Platform credentials */}
          <Section title="Power Platform Credentials" subtitle="Optional — BTG_PP_* overrides (falls back to Azure credentials if not set)">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {ppRows.map(({ label, value }) => (
                  <tr key={label} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 0', fontSize: 11, color: 'var(--muted)', width: 180 }}>{label}</td>
                    <td style={{ padding: '8px 0', fontSize: 11, color: 'var(--text)', fontFamily: 'monospace' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* Subscriptions */}
          <Section title="Subscriptions" subtitle="Azure subscriptions to scan">
            {subs.map(s => (
              <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <StatusDot ok={!!s.is_active} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.subscription_id}</div>
                </div>
                <span style={{ fontSize: 10, color: s.is_active ? OK : 'var(--muted)', fontWeight: 700 }}>{s.is_active ? 'Active' : 'Inactive'}</span>
              </div>
            ))}
            {subs.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>No subscriptions found.</div>}

            {showAddSub ? (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7, background: 'var(--card2)', borderRadius: 6, padding: '12px 14px', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Add Subscription</div>
                {[
                  ['Name', 'name', 'Production', 'text'],
                  ['Subscription ID', 'subscription_id', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', 'text'],
                  ['Tenant ID', 'tenant_id', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', 'text'],
                  ['Client ID', 'client_id', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', 'text'],
                  ['Client Secret', 'client_secret', '(optional, uses .env.local if blank)', 'password'],
                ].map(([label, key, ph, type]) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 10, color: 'var(--muted)', width: 120, flexShrink: 0 }}>{label}</div>
                    <input
                      type={type}
                      placeholder={ph}
                      value={(newSub as Record<string,string>)[key] || ''}
                      onChange={e => setNewSub(s => ({ ...s, [key]: e.target.value }))}
                      style={{ flex: 1, fontSize: 11, padding: '4px 8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)' }}
                    />
                  </div>
                ))}
                {addingSubError && <div style={{ fontSize: 10, color: ERR }}>{addingSubError}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                  <button onClick={addSubscription} style={{ padding: '4px 14px', fontSize: 11, fontWeight: 700, background: ACCENT, border: 'none', borderRadius: 3, color: '#000', cursor: 'pointer' }}>Add</button>
                  <button onClick={() => { setShowAddSub(false); setAddingSubError(''); }} style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--muted)', cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowAddSub(true)} style={{ marginTop: 8, padding: '4px 12px', fontSize: 11, fontWeight: 700, background: 'transparent', border: `1px solid ${ACCENT}`, borderRadius: 3, color: ACCENT, cursor: 'pointer' }}>
                + Add Subscription
              </button>
            )}
          </Section>

          {/* Scheduled Audits */}
          <Section title="Scheduled Audits" subtitle="Auto-run audits on a schedule (requires a cron job hitting /api/schedule/run)">
            {schedules.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>No schedules configured.</div>}
            {schedules.map(s => (
              <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
                    {s.frequency} at {String(s.hour).padStart(2,'0')}:00
                    {s.next_run_at ? ` · next: ${s.next_run_at.slice(0,16)}` : ''}
                  </div>
                </div>
                <button onClick={() => toggleSchedule(s.id, s.enabled)} style={{
                  padding: '2px 10px', fontSize: 10, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                  background: s.enabled ? 'rgba(46,213,115,0.15)' : 'rgba(91,111,168,0.15)',
                  border: `1px solid ${s.enabled ? 'rgba(46,213,115,0.4)' : 'var(--border)'}`,
                  color: s.enabled ? OK : 'var(--muted)',
                }}>{s.enabled ? 'Enabled' : 'Disabled'}</button>
                <button onClick={() => deleteSchedule(s.id)} style={{ padding: '2px 8px', fontSize: 10, background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--muted)', cursor: 'pointer' }}>✕</button>
              </div>
            ))}

            <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>Name</div>
                <input value={newSched.name} onChange={e => setNewSched(s => ({...s, name: e.target.value}))}
                  style={{ fontSize: 11, padding: '4px 8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', width: 140 }} />
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>Frequency</div>
                <select value={newSched.frequency} onChange={e => setNewSched(s => ({...s, frequency: e.target.value}))}
                  style={{ fontSize: 11, padding: '4px 8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)' }}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>Hour (0-23)</div>
                <input type="number" min="0" max="23" value={newSched.hour} onChange={e => setNewSched(s => ({...s, hour: e.target.value}))}
                  style={{ fontSize: 11, padding: '4px 8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', width: 60 }} />
              </div>
              <button onClick={addSchedule} style={{ padding: '5px 12px', fontSize: 11, fontWeight: 700, background: ACCENT, border: 'none', borderRadius: 3, color: '#000', cursor: 'pointer' }}>
                + Add Schedule
              </button>
              {addingSchedMsg && <span style={{ fontSize: 10, color: addingSchedMsg.includes('Failed') ? ERR : OK }}>{addingSchedMsg}</span>}
            </div>
          </Section>

          {/* User Management */}
          <Section title="User Management" subtitle="Approve or reject access requests from new users">
            {usersLoading ? (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading…</div>
            ) : users.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>No registered users yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* Pending first */}
                {['pending', 'active', 'rejected'].map(group => {
                  const grouped = users.filter(u => u.status === group);
                  if (grouped.length === 0) return null;
                  return (
                    <div key={group}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, marginTop: group !== 'pending' ? 10 : 0 }}>
                        {group === 'pending' ? '⏳ Pending Approval' : group === 'active' ? '✓ Active' : '✕ Rejected'}
                      </div>
                      {grouped.map(u => (
                        <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.name || '(no name)'}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.email}
                            </div>
                            <div style={{ fontSize: 9, color: 'var(--dim)', marginTop: 1 }}>
                              Requested {new Date(u.created_at).toLocaleDateString()}
                              {u.approved_at && ` · Processed ${new Date(u.approved_at).toLocaleDateString()}`}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                            {u.status === 'pending' && (
                              <>
                                <button onClick={() => patchUser(u.id, 'active')} style={{
                                  padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                                  background: 'rgba(46,213,115,0.15)', border: '1px solid rgba(46,213,115,0.4)', color: OK,
                                }}>Approve</button>
                                <button onClick={() => patchUser(u.id, 'rejected')} style={{
                                  padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                                  background: 'rgba(255,71,87,0.12)', border: '1px solid rgba(255,71,87,0.35)', color: ERR,
                                }}>Reject</button>
                              </>
                            )}
                            {u.status === 'rejected' && (
                              <button onClick={() => patchUser(u.id, 'active')} style={{
                                padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                                background: 'rgba(46,213,115,0.15)', border: '1px solid rgba(46,213,115,0.4)', color: OK,
                              }}>Re-approve</button>
                            )}
                            {u.status === 'active' && (
                              <button onClick={() => patchUser(u.id, 'rejected')} style={{
                                padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                                background: 'rgba(255,71,87,0.12)', border: '1px solid rgba(255,71,87,0.35)', color: ERR,
                              }}>Revoke</button>
                            )}
                            <button onClick={() => removeUser(u.id)} style={{
                              padding: '3px 8px', fontSize: 10, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                              background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', color: 'var(--muted)',
                            }} title="Delete user">✕</button>
                          </div>
                          {actionMsg?.id === u.id && (
                            <span style={{ fontSize: 10, fontWeight: 600, color: actionMsg.ok ? OK : ERR }}>{actionMsg.text}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Paths */}
          {config && (
            <Section title="Paths" subtitle="Runtime configuration">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {[
                    ['CLI Binary', config.btgPath],
                    ['Database', config.dbPath],
                  ].map(([label, value]) => (
                    <tr key={label} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 0', fontSize: 11, color: 'var(--muted)', width: 180 }}>{label}</td>
                      <td style={{ padding: '8px 0', fontSize: 11, color: 'var(--text)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {/* Env file reference */}
          <Section title="How to Update Credentials" subtitle="">
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.8 }}>
              Edit <code style={{ background: 'var(--bg)', padding: '1px 5px', borderRadius: 3, color: ACCENT, border: '1px solid var(--border)' }}>web/.env.local</code> and restart the server:
            </div>
            <pre style={{ marginTop: 8, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 12px', fontSize: 11, color: 'var(--text)', overflowX: 'auto', lineHeight: 1.7 }}>{`AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-secret
AZURE_SUBSCRIPTION_ID=your-subscription-id

# Optional Power Platform override
BTG_PP_CLIENT_ID=pp-service-principal-client-id
BTG_PP_CLIENT_SECRET=pp-service-principal-secret

# Login credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
SESSION_SECRET=generate-a-random-32-char-string`}</pre>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="glass" style={{ borderRadius: 8, padding: '14px 16px' }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}
