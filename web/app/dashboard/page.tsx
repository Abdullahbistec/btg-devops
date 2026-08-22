'use client';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import KPICard from '@/components/KPICard';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip,
  BarChart, Bar, Cell, PieChart, Pie,
} from 'recharts';

// ── Types ──────────────────────────────────────────────────────────────────
interface DashData {
  kpi: { total: number; critical: number; warning: number; info: number };
  byService: { service: string; count: number }[];
  bySeverity: { severity: string; count: number }[];
  byCategory: { category: string; count: number }[];
  trend: { id: string; name: string; started_at: string; total_findings: number; critical_count: number; warning_count: number; info_count: number }[];
  subscriptions: { id: string; name: string; is_active: number }[];
  recentAudits: { id: string; name: string; status: string; started_at: string; total_findings: number; critical_count: number; warning_count: number }[];
  resolvedAuditId: string;
  ppReady: boolean;
  ppCredsConfigured: boolean;
  resourcesScanned: number;
}

interface Finding {
  id: string; audit_id: string; service: string; resource: string;
  severity: string; category: string; description: string; recommendation: string;
  owner: string; remediation_status?: string;
}

// ── Colours ────────────────────────────────────────────────────────────────
const SEV_COLOR: Record<string, string> = {
  Critical: '#FF4757', Warning: '#FFA502', Info: '#54A0FF',
};
const SERVICE_COLORS = [
  '#00C2FF','#7B5EA7','#FF6B9D','#2ED573','#FFA502','#FF4757',
  '#54A0FF','#A29BFE','#FDCB6E','#6C5CE7','#00B894','#E17055',
];

// ── Outer page — provides Suspense boundary required by useSearchParams ────
export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>Loading…</span>
      </div>
    }>
      <DashboardInner />
    </Suspense>
  );
}

// ── Inner component — reads search params ──────────────────────────────────
function DashboardInner() {
  const searchParams = useSearchParams();
  const router  = useRouter();
  const scope   = searchParams.get('scope')    ?? '';
  const auditId = searchParams.get('audit_id') ?? '';
  const provider: ProviderKey =
    scope === 'azure' ? 'azure' : scope === 'pp' ? 'pp' : scope === 'hetzner' ? 'hetzner' : 'all';
  const isPP    = provider === 'pp';
  const meta    = PROVIDER_META[provider];

  function setProvider(next: ProviderKey) {
    const qs = new URLSearchParams(searchParams.toString());
    if (next === 'all') qs.delete('scope'); else qs.set('scope', next);
    router.replace(`/dashboard?${qs.toString()}`);
  }

  const [data, setData] = useState<DashData | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (auditId) qs.set('audit_id', auditId);
    if (scope)   qs.set('scope', scope);

    const [d, f] = await Promise.all([
      fetch(`/api/dashboard?${qs}`).then(r => r.json()),
      fetch(`/api/findings?${qs}`).then(r => r.json()),
    ]);
    setData(d);
    setFindings(Array.isArray(f) ? f : []);
    setLoading(false);
  }, [auditId, scope]);

  useEffect(() => { load(); }, [load]);

  const sub       = data?.subscriptions?.[0];
  const lastAudit = data?.recentAudits?.[0];

  const trendData = (data?.trend ?? []).map(t => ({
    name: t.started_at ? t.started_at.slice(5, 10) : '—',
    Findings: t.total_findings,
    Critical: t.critical_count,
  }));
  const pieData = (data?.bySeverity ?? []).map(s => ({
    name: s.severity, value: s.count, fill: SEV_COLOR[s.severity] ?? '#888',
  }));
  const serviceData = meta.chartEntries
    ? meta.chartEntries.map(({ svc, color }) => {
        const found = (data?.byService ?? []).find(s => s.service === svc);
        return { name: svc, count: found?.count ?? 0, fill: color };
      })
    : (data?.byService ?? []).slice(0, 10).map((s, i) => ({
        name: s.service, count: s.count, fill: SERVICE_COLORS[i % SERVICE_COLORS.length],
      }));
  const categoryData = (data?.byCategory ?? []).slice(0, 6).map((c, i) => ({
    name: c.category?.slice(0, 22) || 'Unknown', count: c.count,
    fill: SERVICE_COLORS[(i + 3) % SERVICE_COLORS.length],
  }));
  const sparkVals = (data?.trend ?? []).slice(-7).map(t => t.total_findings);
  const critVals  = (data?.trend ?? []).slice(-7).map(t => t.critical_count);
  const warnVals  = (data?.trend ?? []).slice(-7).map(t => t.warning_count);
  const infoVals  = (data?.trend ?? []).slice(-7).map(t => t.info_count);

  const title = meta.title;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* TOPBAR */}
        <div className="glass-sb" style={{
          borderBottom: '1px solid var(--border)',
          padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
              {lastAudit
                ? `Last Audit: ${lastAudit.started_at?.slice(0, 16).replace('T', ' ')} · ${sub?.name ?? ''}`
                : 'No audits yet — run your first audit'}
            </div>
          </div>
          <ProviderFilter active={provider} onChange={setProvider} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {loading && <span style={{ fontSize: 10, color: 'var(--muted)' }}>Loading…</span>}
            <Chip color="var(--good)">● v0.13.0</Chip>
            <Chip color="var(--accent)">22 Tests Passing</Chip>
          </div>
        </div>

        {/* BODY */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* CONTENT */}
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* PP PENDING STATE — shown when the Power Platform provider filter is active but no PP findings exist yet */}
            {isPP && !loading && !data?.ppReady && (
              <PPPendingCard credsConfigured={data?.ppCredsConfigured ?? false} subscriptionId={sub?.id ?? ''} onAuditTriggered={load} />
            )}

            {/* Main content — shown for Azure/All (always) or PP when data is ready */}
            {(!isPP || data?.ppReady) && (
              <>
                {/* KPI ROW */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
                  <KPICard label="Total Findings" value={data?.kpi.total ?? 0} color="#00C2FF" sparkData={sparkVals}
                    icon={<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="#00C2FF" strokeWidth="1.5"><path d="M2 10l3-3 2.5 2 4-5"/></svg>}
                  />
                  <KPICard label="Critical Findings" value={data?.kpi.critical ?? 0} color="#FF4757" sparkData={critVals}
                    icon={<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="#FF4757" strokeWidth="1.5"><circle cx="6.5" cy="6.5" r="5"/><path d="M6.5 4v3M6.5 9v.5"/></svg>}
                  />
                  <KPICard label="Warning Findings" value={data?.kpi.warning ?? 0} color="#FFA502" sparkData={warnVals}
                    icon={<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="#FFA502" strokeWidth="1.5"><path d="M6.5 2L1 11h11L6.5 2z"/><path d="M6.5 7V5M6.5 9v.5"/></svg>}
                  />
                  <KPICard label={meta.kpiLabel} value={data?.resourcesScanned ? String(data.resourcesScanned) : '—'} color="#2ED573" sparkData={infoVals}
                    icon={<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="#2ED573" strokeWidth="1.5"><rect x="1" y="1" width="4.5" height="4.5" rx="1"/><rect x="7.5" y="1" width="4.5" height="4.5" rx="1"/><rect x="1" y="7.5" width="4.5" height="4.5" rx="1"/><rect x="7.5" y="7.5" width="4.5" height="4.5" rx="1"/></svg>}
                  />
                </div>

                {/* CHART ROW 1 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.8fr 1.6fr 1.5fr', gap: 8, minHeight: 220 }}>
                  <Card title="By Severity" sub="Findings distribution" color="#FF4757">
                    {pieData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={130}>
                        <PieChart>
                          <Pie data={pieData} cx="50%" cy="50%" innerRadius={32} outerRadius={52} dataKey="value" paddingAngle={2}>
                            {pieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                          </Pie>
                          <Tooltip contentStyle={{ background: '#0E1333', border: '1px solid #1A2550', borderRadius: 4, fontSize: 11 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : <EmptyState />}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {pieData.map(p => {
                        const pct = data?.kpi.total ? Math.round(p.value / data.kpi.total * 100) : 0;
                        return (
                          <div key={p.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                            {/* Dot + label */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <div style={{ width: 6, height: 6, borderRadius: '50%', background: p.fill, flexShrink: 0 }} />
                              <span style={{ fontSize: 10, color: 'var(--muted)' }}>{p.name}</span>
                            </div>
                            {/* Count + % badge */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ fontSize: 11, fontWeight: 800, color: p.fill, fontVariantNumeric: 'tabular-nums' }}>{p.value}</span>
                              <span style={{
                                fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 999,
                                background: `${p.fill}22`, border: `1px solid ${p.fill}55`, color: p.fill,
                                fontVariantNumeric: 'tabular-nums',
                              }}>{pct}%</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Card>

                  <Card title={meta.chartTitle} sub="Count per analyzer" color="#00C2FF">
                    {serviceData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={155}>
                        <BarChart data={serviceData} layout="vertical" margin={{ top: 0, right: 30, left: 4, bottom: 0 }}>
                          <XAxis type="number" tick={{ fill: '#2A3560', fontSize: 9 }} axisLine={false} tickLine={false} />
                          <YAxis type="category" dataKey="name" tick={{ fill: '#5B6FA8', fontSize: 10 }} axisLine={false} tickLine={false} width={meta.yAxisWidth} />
                          <Tooltip contentStyle={{ background: '#0E1333', border: '1px solid #1A2550', borderRadius: 4, fontSize: 11 }} />
                          <Bar dataKey="count" radius={[0, 2, 2, 0]}>
                            {serviceData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <EmptyState />}
                  </Card>

                  <Card title="By Category" sub="Finding type breakdown" color="#FFA502">
                    {categoryData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={155}>
                        <BarChart data={categoryData} layout="vertical" margin={{ top: 0, right: 30, left: 4, bottom: 0 }}>
                          <XAxis type="number" tick={{ fill: '#2A3560', fontSize: 9 }} axisLine={false} tickLine={false} />
                          <YAxis type="category" dataKey="name" tick={{ fill: '#5B6FA8', fontSize: 10 }} axisLine={false} tickLine={false} width={110} />
                          <Tooltip contentStyle={{ background: '#0E1333', border: '1px solid #1A2550', borderRadius: 4, fontSize: 11 }} />
                          <Bar dataKey="count" radius={[0, 2, 2, 0]}>
                            {categoryData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <EmptyState />}
                  </Card>

                  <Card title="Recent Audits" sub="Latest runs" color="#2ED573">
                    <RecentAuditsList audits={data?.recentAudits ?? []} />
                  </Card>
                </div>

                {/* CHART ROW 2 */}
                <div style={{ display: 'grid', gridTemplateColumns: '2.5fr 1.5fr', gap: 8, minHeight: 200 }}>
                  <Card title="Findings Trend Over Time" sub="Total findings per audit run" color="#7B5EA7">
                    {trendData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={130}>
                        <AreaChart data={trendData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                          <defs>
                            <linearGradient id="tgf" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#00C2FF" stopOpacity={0.3} />
                              <stop offset="100%" stopColor="#00C2FF" stopOpacity={0.02} />
                            </linearGradient>
                            <linearGradient id="tgc" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#FF4757" stopOpacity={0.25} />
                              <stop offset="100%" stopColor="#FF4757" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <XAxis dataKey="name" tick={{ fill: '#2A3560', fontSize: 9 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: '#2A3560', fontSize: 9 }} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={{ background: '#0E1333', border: '1px solid #1A2550', borderRadius: 4, fontSize: 11 }} />
                          <Area type="monotone" dataKey="Findings" stroke="#00C2FF" strokeWidth={2} fill="url(#tgf)" dot={false} />
                          <Area type="monotone" dataKey="Critical" stroke="#FF4757" strokeWidth={1.5} fill="url(#tgc)" dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : <EmptyState msg="Run an audit to see trends" />}
                    <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                      <LegDot color="#00C2FF" label="Findings" />
                      <LegDot color="#FF4757" label="Critical" />
                    </div>
                  </Card>

                  <Card title="Compliance by Service" sub="% of resources with no critical findings" color="#54A0FF">
                    <ComplianceList findings={findings} />
                  </Card>
                </div>

                {/* FINDINGS TABLE */}
                <FindingsCard findings={findings} svcTabs={meta.svcTabs} label={meta.findingsLabel} />
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

// ── PP Pending Card ────────────────────────────────────────────────────────
function PPPendingCard({ credsConfigured, subscriptionId, onAuditTriggered }: {
  credsConfigured: boolean;
  subscriptionId: string;
  onAuditTriggered: () => void;
}) {
  const [running, setRunning] = useState(false);

  async function runAudit() {
    setRunning(true);
    try {
      const res = await fetch('/api/audits/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription_id: subscriptionId,
          commands: ['powerplatform', 'pp-environments', 'pp-apps', 'pp-flows', 'pp-powerbi'],
          name: `Power Platform Scan ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
        }),
      });
      if (res.ok) onAuditTriggered();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="glass" style={{
      borderRadius: 8, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 14,
      borderColor: 'rgba(255,165,2,0.25) !important',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 6,
          background: '#FFA50220', border: '1px solid #FFA50240',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#FFA502" strokeWidth="1.5">
            <path d="M8 2L1 14h14L8 2z"/><path d="M8 7v3M8 11.5v.5"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
            Power Platform Data Unavailable
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            No Power Platform findings in the database yet.
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: 'var(--border)' }} />

      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        Power Platform analyzers require the service principal to be registered
        as a <strong style={{ color: 'var(--text)' }}>Power Platform management app</strong>.
        A Global Admin or Power Platform Admin must run:
      </div>

      <div style={{
        background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 3,
        padding: '10px 14px', fontFamily: 'Consolas, monospace', fontSize: 11, color: '#A29BFE',
        lineHeight: 1.7,
      }}>
        <div style={{ color: 'var(--muted)', marginBottom: 4 }}># In PowerShell (Global Admin)</div>
        <div>Install-Module -Name Microsoft.PowerApps.Administration.PowerShell</div>
        <div>Add-PowerAppsAccount</div>
        <div>New-PowerAppManagementApp -ApplicationId &quot;{'{'}AZURE_CLIENT_ID{'}'}&quot;</div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        Then assign these Entra ID roles to the service principal:
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          ['Power Platform Administrator', 'pp-environments, pp-apps, pp-flows'],
          ['Power BI Administrator', 'pp-powerbi'],
          ['Organization.Read.All (Graph)', 'powerplatform (licensing)'],
        ].map(([role, scope]) => (
          <div key={role} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11 }}>
            <span style={{ color: 'var(--good)', fontWeight: 700, flexShrink: 0 }}>•</span>
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>{role}</span>
            <span style={{ color: 'var(--dim)', fontSize: 10 }}>→ {scope}</span>
          </div>
        ))}
      </div>

      {!credsConfigured && (
        <>
          <div style={{ height: 1, background: 'var(--border)' }} />
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Optionally set separate PP credentials in <code style={{ color: 'var(--accent)', fontSize: 10 }}>.env.local</code>:
          </div>
          <div style={{
            background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 3,
            padding: '8px 14px', fontFamily: 'Consolas, monospace', fontSize: 11, color: '#A29BFE', lineHeight: 1.7,
          }}>
            <div>BTG_PP_TENANT_ID=your-tenant-id</div>
            <div>BTG_PP_CLIENT_ID=your-pp-client-id</div>
            <div>BTG_PP_CLIENT_SECRET=your-pp-secret</div>
          </div>
        </>
      )}

      <div style={{ height: 1, background: 'var(--border)' }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          Once setup is complete, run a new audit to populate Power Platform findings.
        </div>
        <button
          onClick={runAudit}
          disabled={running}
          style={{
            padding: '6px 16px', fontSize: 11, fontWeight: 700, flexShrink: 0,
            background: running ? 'transparent' : 'var(--accent2)',
            border: '1px solid var(--accent2)', borderRadius: 3, color: running ? 'var(--accent2)' : '#fff',
            opacity: running ? 0.7 : 1,
          }}
        >
          {running ? '⟳ Running…' : '▶ Run New Audit'}
        </button>
      </div>
    </div>
  );
}

// ── Helper components ──────────────────────────────────────────────────────

type AuditRow = { id: string; name: string; status: string; started_at: string; total_findings: number; critical_count: number; warning_count: number };

function RecentAuditsList({ audits }: { audits: AuditRow[] }) {
  const [open, setOpen] = useState(false);
  const SHOW = 3;

  if (audits.length === 0) return <EmptyState />;
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {audits.slice(0, SHOW).map(a => <AuditRow key={a.id} a={a} />)}
        {audits.length > SHOW && (
          <button onClick={() => setOpen(true)} style={{
            marginTop: 6, width: '100%', padding: '4px 0', fontSize: 10, fontWeight: 600,
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 3, color: 'var(--muted)', cursor: 'pointer',
          }}>
            View All ({audits.length}) ▼
          </button>
        )}
      </div>

      {/* Slide-over — rendered via portal so it escapes the grid stacking context */}
      {open && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9998,
          }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 400,
            zIndex: 9999, display: 'flex', flexDirection: 'column',
            background: 'rgba(5,8,24,0.98)',
            borderLeft: '1px solid rgba(0,194,255,0.18)',
            backdropFilter: 'blur(32px)',
            boxShadow: '-12px 0 60px rgba(0,0,0,0.7)',
          }}>
            <div style={{
              padding: '16px 18px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>Recent Audits</div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{audits.length} total runs</div>
              </div>
              <button onClick={() => setOpen(false)} style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 4,
                color: 'var(--muted)', cursor: 'pointer', fontSize: 14, padding: '2px 9px', lineHeight: 1.4,
              }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 18px' }}>
              {audits.map(a => (
                <div key={a.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 0', borderBottom: '1px solid var(--border)',
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.name?.replace(/\s+\d+$/, '') || a.id.slice(0, 8)}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                      {a.started_at?.slice(0, 16).replace('T', ' ')}
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 5, fontSize: 10 }}>
                      <span style={{ color: '#FF4757', fontWeight: 700 }}>⬤ {a.critical_count} critical</span>
                      <span style={{ color: '#FFA502', fontWeight: 700 }}>⬤ {a.warning_count} warning</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 14 }}>
                    <div style={{ fontSize: 18, color: 'var(--accent)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{a.total_findings}</div>
                    <StatusBadge status={a.status} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}

function AuditRow({ a }: { a: AuditRow }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 10, color: 'var(--text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {a.name?.replace(/\s+\d+$/, '') || a.id.slice(0, 8)}
        </div>
        <div style={{ fontSize: 9, color: 'var(--muted)' }}>{a.started_at?.slice(0, 10)}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 6 }}>
        <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{a.total_findings}</div>
        <StatusBadge status={a.status} />
      </div>
    </div>
  );
}

function Card({ title, sub, children, color = '#00C2FF' }: { title: string; sub?: string; children: React.ReactNode; color?: string }) {
  return (
    <div className="glass" style={{
      borderRadius: 8, padding: '10px 12px 10px 16px', display: 'flex', flexDirection: 'column', gap: 6, cursor: 'default',
      border: `1px solid ${color}66`,
      boxShadow: `0 0 20px ${color}20, 0 4px 24px rgba(0,0,0,0.12), inset 0 1px 0 ${color}15`,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Coloured left accent bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 3, background: `linear-gradient(180deg, ${color}, ${color}33)`, borderRadius: '8px 0 0 8px' }} />
      {/* Subtle top glow line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, ${color}88, transparent)` }} />
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</div>
        {sub && <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function ProviderFilter({ active, onChange }: { active: ProviderKey; onChange: (key: ProviderKey) => void }) {
  return (
    <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 6, background: 'var(--card2)', border: '1px solid var(--border)' }}>
      {PROVIDER_TABS.map(({ key, label }) => {
        const isActive = active === key;
        return (
          <button key={key} onClick={() => onChange(key)} style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
            background: isActive ? 'var(--accent)' : 'transparent',
            border: '1px solid transparent',
            color: isActive ? '#0A0F2C' : 'var(--muted)',
            transition: 'all 0.15s ease',
          }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 3, background: `${color}1A`, color, border: `1px solid ${color}40` }}>
      {children}
    </span>
  );
}

function SevChip({ sev }: { sev: string }) {
  const c = SEV_COLOR[sev] ?? '#888';
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 3, background: `${c}1A`, color: c, border: `1px solid ${c}40` }}>
      {sev}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    completed: ['var(--good)', '✓'],
    running:   ['var(--warn)', '⟳'],
    failed:    ['var(--crit)', '✕'],
    pending:   ['var(--muted)', '…'],
  };
  const [color, icon] = map[status] ?? ['var(--muted)', '?'];
  return <span style={{ fontSize: 9, color, fontWeight: 700 }}>{icon} {status}</span>;
}

function LegDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--muted)' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {label}
    </div>
  );
}

function EmptyState({ msg = 'Run an audit to see data' }: { msg?: string }) {
  return <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 11 }}>{msg}</div>;
}

const REMEDIATION_OPTIONS = [
  { value: 'open',         label: 'Open',         color: '#FF4757' },
  { value: 'acknowledged', label: 'Acknowledged',  color: '#FFA502' },
  { value: 'resolved',     label: 'Resolved',      color: '#2ED573' },
  { value: 'suppressed',   label: 'Suppressed',    color: '#5B6FA8' },
];

function RemediationControl({ findingId }: { findingId: string }) {
  const [status, setStatus] = useState<string>('open');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/findings/${findingId}`).then(r => r.ok ? r.json() : null).then(d => {
      if (d?.remediation_status) setStatus(d.remediation_status);
      setLoading(false);
    });
  }, [findingId]);

  async function save(val: string) {
    setSaving(true);
    setStatus(val);
    await fetch(`/api/findings/${findingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remediation_status: val }),
    });
    setSaving(false);
  }

  const current = REMEDIATION_OPTIONS.find(o => o.value === status) ?? REMEDIATION_OPTIONS[0];

  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        Remediation Status {saving && <span style={{ color: 'var(--accent)' }}>· saving…</span>}
      </div>
      {loading ? (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {REMEDIATION_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => save(opt.value)} style={{
              padding: '4px 12px', fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: 'pointer',
              background: status === opt.value ? `${opt.color}20` : 'transparent',
              border: `1px solid ${status === opt.value ? opt.color : 'var(--border)'}`,
              color: status === opt.value ? opt.color : 'var(--muted)',
              transition: 'all 0.12s',
            }}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10, color: current.color, fontWeight: 600 }}>
        Currently: {current.label}
      </div>
    </div>
  );
}

function ComplianceList({ findings }: { findings: Finding[] }) {
  const services = [...new Set(findings.map(f => f.service))];
  if (services.length === 0) return <EmptyState />;
  const rows = services.slice(0, 7).map(svc => {
    const total = findings.filter(f => f.service === svc).length;
    const crit  = findings.filter(f => f.service === svc && f.severity === 'Critical').length;
    const score = total > 0 ? Math.round((1 - crit / total) * 100) : 100;
    const color = score >= 80 ? '#2ED573' : score >= 50 ? '#FFA502' : '#FF4757';
    return { svc, score, color };
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, paddingTop: 4 }}>
      {rows.map(r => (
        <div key={r.svc} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.svc}</span>
            <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{r.score}%</span>
          </div>
          <div style={{ height: 5, background: 'var(--card2)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${r.score}%`, background: r.color, borderRadius: 2, transition: 'width 0.6s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

type SevTab = 'All' | 'Critical' | 'Warning' | 'Info';

interface SvcTabDef { key: string; label: string; match: string | null; color: string }

const SEV_TABS: { key: SevTab; color: string; bg: string }[] = [
  { key: 'All',      color: '#00C2FF', bg: 'rgba(0,194,255,0.12)'  },
  { key: 'Critical', color: '#FF4757', bg: 'rgba(255,71,87,0.12)'  },
  { key: 'Warning',  color: '#FFA502', bg: 'rgba(255,165,2,0.12)'  },
  { key: 'Info',     color: '#54A0FF', bg: 'rgba(84,160,255,0.12)' },
];

const REM_STATUS_TABS: { key: string; label: string; color: string }[] = [
  { key: 'all',          label: 'All',          color: '#00C2FF' },
  { key: 'open',         label: 'Open',         color: '#FF4757' },
  { key: 'acknowledged', label: 'Acknowledged', color: '#FFA502' },
  { key: 'resolved',     label: 'Resolved',     color: '#2ED573' },
  { key: 'suppressed',   label: 'Suppressed',   color: '#5B6FA8' },
];

const AZURE_SVC_TABS: SvcTabDef[] = [
  { key: 'all',            label: 'All',            match: null,             color: '#A29BFE' },
  { key: 'ACR',            label: 'ACR',            match: 'ACR',            color: '#00C2FF' },
  { key: 'IAM',            label: 'IAM',            match: 'IAM',            color: '#FF6B9D' },
  { key: 'Resource Group', label: 'Resource Group', match: 'Resource Group', color: '#2ED573' },
];

const PP_SVC_TABS: SvcTabDef[] = [
  { key: 'all',              label: 'All',              match: null,               color: '#A29BFE' },
  { key: 'Power Platform',   label: 'Power Platform',   match: 'Power Platform',   color: '#00C2FF' },
  { key: 'PP Environments',  label: 'PP Environments',  match: 'PP Environments',  color: '#7B5EA7' },
  { key: 'PP Apps',          label: 'PP Apps',          match: 'PP Apps',          color: '#FFA502' },
  { key: 'PP Flows',         label: 'PP Flows',         match: 'PP Flows',         color: '#2ED573' },
  { key: 'Power BI',         label: 'Power BI',         match: 'Power BI',         color: '#F2C811' },
];

const HETZNER_SVC_TABS: SvcTabDef[] = [
  { key: 'all',                   label: 'All',                   match: null,                    color: '#A29BFE' },
  { key: 'Hetzner Servers',       label: 'Servers',                match: 'Hetzner Servers',       color: '#D50C2D' },
  { key: 'Hetzner Volumes',       label: 'Volumes',                match: 'Hetzner Volumes',       color: '#FF8C42' },
  { key: 'Hetzner Floating IPs',  label: 'Floating IPs',           match: 'Hetzner Floating IPs',  color: '#4ECDC4' },
  { key: 'Hetzner Firewalls',     label: 'Firewalls',              match: 'Hetzner Firewalls',     color: '#C44536' },
  { key: 'Hetzner Certificates',  label: 'Certificates',           match: 'Hetzner Certificates',  color: '#6A0572' },
];

// All Providers view combines every known service tab behind one filter row.
const ALL_SVC_TABS: SvcTabDef[] = [
  { key: 'all', label: 'All', match: null, color: '#A29BFE' },
  ...AZURE_SVC_TABS.filter(t => t.key !== 'all'),
  ...PP_SVC_TABS.filter(t => t.key !== 'all'),
  ...HETZNER_SVC_TABS.filter(t => t.key !== 'all'),
];

// ── Provider filter — the single source of truth every provider-specific
// branch (title, KPI label, chart shape, findings tabs) reads from. Adding a
// future provider means adding one entry here, not a new page/branch.
type ProviderKey = 'all' | 'azure' | 'pp' | 'hetzner';

const PROVIDER_TABS: { key: ProviderKey; label: string }[] = [
  { key: 'all',     label: 'All Providers' },
  { key: 'azure',   label: 'Azure' },
  { key: 'pp',      label: 'Power Platform' },
  { key: 'hetzner', label: 'Hetzner' },
];

interface ProviderMeta {
  title: string;
  kpiLabel: string;
  chartTitle: string;
  chartEntries: { svc: string; color: string }[] | null; // null = derive top 10 from byService
  yAxisWidth: number;
  svcTabs: SvcTabDef[];
  findingsLabel: string;
}

// PP mode: always show all 5 PP services (with 0 if no findings yet)
const PP_CHART_ENTRIES = [
  { svc: 'Power Platform', color: '#00C2FF' },
  { svc: 'PP Environments', color: '#7B5EA7' },
  { svc: 'PP Apps',         color: '#FFA502' },
  { svc: 'PP Flows',        color: '#2ED573' },
  { svc: 'Power BI',        color: '#F2C811' },
];

// Hetzner mode: always show all 5 Hetzner analyzers (with 0 if no findings yet)
const HETZNER_CHART_ENTRIES = [
  { svc: 'Hetzner Servers',      color: '#D50C2D' },
  { svc: 'Hetzner Volumes',      color: '#FF8C42' },
  { svc: 'Hetzner Floating IPs', color: '#4ECDC4' },
  { svc: 'Hetzner Firewalls',    color: '#C44536' },
  { svc: 'Hetzner Certificates', color: '#6A0572' },
];

const PROVIDER_META: Record<ProviderKey, ProviderMeta> = {
  all: {
    title: 'BTG DevOps — Security Dashboard',
    kpiLabel: 'Resources Scanned',
    chartTitle: 'Findings by Service',
    chartEntries: null,
    yAxisWidth: 90,
    svcTabs: ALL_SVC_TABS,
    findingsLabel: 'Latest',
  },
  azure: {
    title: 'BTG DevOps — Azure Security Dashboard',
    kpiLabel: 'Resources Scanned',
    chartTitle: 'Findings by Service',
    chartEntries: null,
    yAxisWidth: 90,
    svcTabs: AZURE_SVC_TABS,
    findingsLabel: 'Latest',
  },
  pp: {
    title: 'BTG DevOps — Power Platform Dashboard',
    kpiLabel: 'Environments Scanned',
    chartTitle: 'Findings by PP Analyzer',
    chartEntries: PP_CHART_ENTRIES,
    yAxisWidth: 110,
    svcTabs: PP_SVC_TABS,
    findingsLabel: 'Power Platform',
  },
  hetzner: {
    title: 'BTG DevOps — Hetzner Cloud Dashboard',
    kpiLabel: 'Resources Scanned',
    chartTitle: 'Findings by Hetzner Analyzer',
    chartEntries: HETZNER_CHART_ENTRIES,
    yAxisWidth: 110,
    svcTabs: HETZNER_SVC_TABS,
    findingsLabel: 'Hetzner',
  },
};

function FindingsCard({ findings, svcTabs, label }: { findings: Finding[]; svcTabs: SvcTabDef[]; label: string }) {
  const [sevTab,  setSevTab]  = useState<SevTab>('All');
  const [svcKey,  setSvcKey]  = useState<string>('all');
  const [remTab,  setRemTab]  = useState<string>('all');
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<Finding | null>(null);

  function switchSev(t: SevTab)  { setSevTab(t);  setExpanded(false); }
  function switchSvc(k: string)  { setSvcKey(k);  setExpanded(false); }
  function switchRem(k: string)  { setRemTab(k);  setExpanded(false); }

  // Active service tab definition
  const activeSvcCfg: SvcTabDef = svcTabs.find(t => t.key === svcKey) ?? svcTabs[0];

  // Apply severity filter, then service filter, then remediation-status filter
  const sevFiltered = sevTab === 'All' ? findings : findings.filter(f => f.severity === sevTab);
  const svcFiltered = activeSvcCfg.match
    ? sevFiltered.filter(f => f.service === activeSvcCfg.match)
    : sevFiltered;
  const tabFindings = remTab === 'all'
    ? svcFiltered
    : svcFiltered.filter(f => (f.remediation_status || 'open') === remTab);

  const remCounts: Record<string, number> = { all: svcFiltered.length, open: 0, acknowledged: 0, resolved: 0, suppressed: 0 };
  for (const f of svcFiltered) {
    const st = f.remediation_status || 'open';
    remCounts[st] = (remCounts[st] || 0) + 1;
  }

  // Severity counts (within the active service filter)
  const svcBase = activeSvcCfg.match
    ? findings.filter(f => f.service === activeSvcCfg.match)
    : findings;
  const sevCounts: Record<SevTab, number> = {
    All:      svcBase.length,
    Critical: svcBase.filter(f => f.severity === 'Critical').length,
    Warning:  svcBase.filter(f => f.severity === 'Warning').length,
    Info:     svcBase.filter(f => f.severity === 'Info').length,
  };

  // Service counts (within the active severity filter)
  const sevBase = sevTab === 'All' ? findings : findings.filter(f => f.severity === sevTab);
  function svcCount(tab: SvcTabDef) {
    return tab.match ? sevBase.filter(f => f.service === tab.match).length : sevBase.length;
  }

  const PAGE    = 10;
  const visible = expanded ? tabFindings : tabFindings.slice(0, PAGE);
  const hasMore = tabFindings.length > PAGE;
  const activeSevCfg = SEV_TABS.find(t => t.key === sevTab)!;

  return (
    <div className="glass" style={{ borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 0, cursor: 'default' }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {label} Findings ({tabFindings.length})
          </div>
          <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 1 }}>
            Showing {Math.min(PAGE, tabFindings.length)} of {tabFindings.length}
            {sevTab !== 'All' && ` · ${sevTab}`}
            {svcKey !== 'all' && ` · ${activeSvcCfg.label}`}
          </div>
        </div>

        {/* View All button top-right */}
        {hasMore && (
          <button onClick={() => setExpanded(e => !e)} style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: 'pointer', flexShrink: 0,
            background: 'transparent', border: `1px solid ${activeSevCfg.color}`,
            color: activeSevCfg.color, transition: 'all 0.15s',
          }}>
            {expanded ? '▲ Collapse' : `View All (${tabFindings.length}) ▼`}
          </button>
        )}
      </div>

      {/* Tab rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>

        {/* Severity tabs */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.07em', width: 52, flexShrink: 0 }}>Severity</span>
          <div style={{ display: 'flex', gap: 3 }}>
            {SEV_TABS.map(({ key, color, bg }) => {
              const isActive = sevTab === key;
              return (
                <button key={key} onClick={() => switchSev(key)} className="tab-pill" style={{
                  padding: '3px 11px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  background: isActive ? `${color}30` : `${color}10`,
                  border: `1.5px solid ${isActive ? color : `${color}50`}`,
                  color: isActive ? '#fff' : `${color}bb`,
                  boxShadow: isActive
                    ? `0 0 14px ${color}99, 0 0 28px ${color}44, inset 0 1px 0 rgba(255,255,255,0.25)`
                    : `0 0 6px ${color}22`,
                }}>
                  {key}
                  <span style={{ marginLeft: 3, opacity: 0.75, fontVariantNumeric: 'tabular-nums', fontSize: 9 }}>
                    {sevCounts[key]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Service tabs */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.07em', width: 52, flexShrink: 0 }}>Service</span>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {svcTabs.map((tab: SvcTabDef) => {
              const isActive = svcKey === tab.key;
              return (
                <button key={tab.key} onClick={() => switchSvc(tab.key)} className="tab-pill" style={{
                  padding: '3px 11px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  background: isActive ? `${tab.color}30` : `${tab.color}10`,
                  border: `1.5px solid ${isActive ? tab.color : `${tab.color}50`}`,
                  color: isActive ? '#fff' : `${tab.color}bb`,
                  boxShadow: isActive
                    ? `0 0 14px ${tab.color}99, 0 0 28px ${tab.color}44, inset 0 1px 0 rgba(255,255,255,0.25)`
                    : `0 0 6px ${tab.color}22`,
                }}>
                  {tab.label}
                  <span style={{ marginLeft: 3, opacity: 0.75, fontVariantNumeric: 'tabular-nums', fontSize: 9 }}>
                    {svcCount(tab)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Remediation status tabs */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.07em', width: 52, flexShrink: 0 }}>Status</span>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {REM_STATUS_TABS.map(({ key, label, color }) => {
              const isActive = remTab === key;
              return (
                <button key={key} onClick={() => switchRem(key)} className="tab-pill" style={{
                  padding: '3px 11px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  background: isActive ? `${color}30` : `${color}10`,
                  border: `1.5px solid ${isActive ? color : `${color}50`}`,
                  color: isActive ? '#fff' : `${color}bb`,
                  boxShadow: isActive
                    ? `0 0 14px ${color}99, 0 0 28px ${color}44, inset 0 1px 0 rgba(255,255,255,0.25)`
                    : `0 0 6px ${color}22`,
                }}>
                  {label}
                  <span style={{ marginLeft: 3, opacity: 0.75, fontVariantNumeric: 'tabular-nums', fontSize: 9 }}>
                    {remCounts[key] ?? 0}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Severity', 'Service', 'Resource', 'Owner', 'Category', 'Description'].map(h => (
                <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(f => (
              <tr key={f.id} onClick={() => setDetail(f)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(0,194,255,0.05)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
              >
                <td style={{ padding: '8px 10px' }}><SevChip sev={f.severity} /></td>
                <td style={{ padding: '8px 10px', color: 'var(--accent)', fontSize: 11, fontFamily: 'Consolas,monospace' }}>{f.service}</td>
                <td style={{ padding: '8px 10px', color: 'var(--text)', fontWeight: 500, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.resource || '—'}</td>
                <td style={{ padding: '8px 10px', color: f.owner ? '#B39DDB' : 'var(--dim)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.owner || '—'}</td>
                <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{f.category}</td>
                <td style={{ padding: '8px 10px', color: 'var(--text)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.description}</td>
              </tr>
            ))}
            {tabFindings.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '24px 10px', textAlign: 'center', color: 'var(--muted)' }}>
                No {[sevTab !== 'All' ? sevTab.toLowerCase() : '', svcKey !== 'all' ? activeSvcCfg.label : ''].filter(Boolean).join(' / ') || 'matching'} findings.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom collapse */}
      {expanded && hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
          <button onClick={() => setExpanded(false)} style={{
            padding: '3px 14px', fontSize: 10, fontWeight: 700,
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 3, color: 'var(--muted)', cursor: 'pointer',
          }}>
            ▲ Collapse
          </button>
        </div>
      )}

      {/* Finding detail slide-over */}
      {detail && typeof document !== 'undefined' && createPortal(
        <>
          <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9998 }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, zIndex: 9999,
            background: 'rgba(5,8,24,0.98)', borderLeft: '1px solid rgba(0,194,255,0.18)',
            backdropFilter: 'blur(32px)', boxShadow: '-12px 0 60px rgba(0,0,0,0.7)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Header */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SevChip sev={detail.severity} />
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{detail.category || 'Finding Detail'}</span>
              </div>
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--muted)', cursor: 'pointer', fontSize: 14, padding: '2px 9px' }}>✕</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Meta chips */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(0,194,255,0.12)', border: '1px solid rgba(0,194,255,0.3)', borderRadius: 3, color: 'var(--accent)', fontFamily: 'monospace' }}>{detail.service}</span>
                {detail.resource && <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--muted)', fontFamily: 'monospace' }}>{detail.resource}</span>}
                {detail.owner && <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(122,94,167,0.12)', border: '1px solid rgba(122,94,167,0.35)', borderRadius: 3, color: '#B39DDB' }}>👤 {detail.owner}</span>}
              </div>

              {/* Description */}
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Description</div>
                <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7, background: 'var(--card2)', borderRadius: 6, padding: '10px 12px', border: '1px solid var(--border)' }}>
                  {detail.description || 'No description provided.'}
                </div>
              </div>

              {/* Recommendation */}
              {detail.recommendation && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Recommendation</div>
                  <div style={{ fontSize: 12, color: 'var(--good)', lineHeight: 1.7, background: 'rgba(46,213,115,0.06)', borderRadius: 6, padding: '10px 12px', border: '1px solid rgba(46,213,115,0.2)' }}>
                    {detail.recommendation}
                  </div>
                </div>
              )}

              {/* Remediation status */}
              <RemediationControl findingId={detail.id} />
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
