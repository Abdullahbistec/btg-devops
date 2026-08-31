'use client';
import { useEffect, useState, useMemo, useCallback } from 'react';
import Sidebar from '@/components/Sidebar';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';

interface CostFinding {
  id: string;
  service: string;
  category: string;
  severity: string;
  resource: string;
  description: string;
  recommendation: string;
}

interface AuditInfo {
  id: string;
  name: string;
  started_at: string;
}

const COST_CATEGORIES = new Set([
  'License Waste', 'Severe License Waste', 'Zero Usage', 'Suspended License',
  'Unused', 'Empty Plan', 'Over-provisioned', 'Overprovisioned', 'Trial License in Use',
  'Unused IP', 'Orphaned', 'Stale App', 'Stale Flow',
]);

const ACCENT = '#00C2FF';
const WARN = '#FFA502';
const CRIT = '#FF4757';
const INFO = '#54A0FF';
const GOOD = '#2ED573';

function sevColor(s: string) {
  if (s === 'Critical') return CRIT;
  if (s === 'Warning') return WARN;
  return INFO;
}

interface SpendData {
  subscription: { id: string; name: string };
  totalCost: number;
  currency: string;
  byService: { name: string; cost: number }[];
  byResourceGroup: { name: string; cost: number }[];
  fetchedAt: string;
  noData?: boolean;
  message?: string;
  monthlyBudget: number | null;
}

const REFRESH_POLL_MS = 4000;
const REFRESH_TIMEOUT_MS = 10 * 60 * 1000; // the routine polls every few minutes — give it real headroom

// Minimum real history points before a line is meaningful — below this,
// show an honest "still accumulating" placeholder instead of a near-empty
// chart that reads as broken.
const MIN_HISTORY_POINTS = 3;

interface HistoryPoint {
  date: string;
  totalCost: number;
  byService: { name: string; cost: number }[];
}
interface HistoryData {
  subscription: { id: string; name: string };
  currency: string;
  timeframe: string;
  points: HistoryPoint[];
}

const SPAN_OPTIONS = [
  { label: '1 month', days: 30 },
  { label: '2 months', days: 60 },
  { label: '3 months', days: 90 },
] as const;

function toISODate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function monthLabel(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Last calendar day of the month `iso` falls in, e.g. '2026-07-15' -> '2026-07-31'. */
function lastDayOfMonthIso(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return toISODate(new Date(y, m, 0));
}

function toServiceMap(list: { name: string; cost: number }[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const s of list) m[s.name] = s.cost;
  return m;
}

function findLastAtOrBefore(points: HistoryPoint[], dateIso: string, minIso: string): HistoryPoint | null {
  let result: HistoryPoint | null = null;
  for (const p of points) {
    if (p.date > dateIso) break;
    if (p.date < minIso) continue;
    result = p;
  }
  return result;
}

function findLastBefore(points: HistoryPoint[], dateIso: string): HistoryPoint | null {
  let result: HistoryPoint | null = null;
  for (const p of points) {
    if (p.date >= dateIso) break;
    result = p;
  }
  return result;
}

/** cost_snapshot_history stores Azure's month-to-date CUMULATIVE cost as of
 * each day, not a daily delta (it resets near zero at the start of every
 * calendar month — see web/lib/db.ts). Turning that into "how much was
 * actually spent between two arbitrary dates" means walking the window one
 * calendar month at a time and subtracting each segment's starting balance
 * — a plain last-minus-first over a multi-month range would double count.
 * `points` should be sorted ascending and extend a bit before `winStart` so
 * a mid-month start has a baseline to subtract instead of silently using 0. */
function deltaForWindow(points: HistoryPoint[], winStart: string, winEnd: string): { total: number; byService: Record<string, number> } {
  if (!points.length || winStart > winEnd) return { total: 0, byService: {} };
  let total = 0;
  const byService: Record<string, number> = {};
  let cursor = winStart;

  while (cursor <= winEnd) {
    const segEnd = Math.min(new Date(lastDayOfMonthIso(cursor) + 'T00:00:00').getTime(), new Date(winEnd + 'T00:00:00').getTime());
    const segEndIso = toISODate(new Date(segEnd));
    const isMonthStart = cursor.endsWith('-01');

    let baseTotal = 0;
    let baseService: Record<string, number> = {};
    if (!isMonthStart) {
      const before = findLastBefore(points, cursor);
      if (before) { baseTotal = before.totalCost; baseService = toServiceMap(before.byService); }
    }

    const end = findLastAtOrBefore(points, segEndIso, cursor);
    const endTotal = end ? end.totalCost : baseTotal;
    const endService = end ? toServiceMap(end.byService) : baseService;

    total += Math.max(0, endTotal - baseTotal);
    new Set([...Object.keys(baseService), ...Object.keys(endService)]).forEach(name => {
      const d = (endService[name] ?? 0) - (baseService[name] ?? 0);
      if (d) byService[name] = (byService[name] ?? 0) + d;
    });

    cursor = addDaysIso(segEndIso, 1);
  }

  return { total, byService };
}

function StatTile({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div className="glass" style={{ borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, marginTop: 4, color: subColor ?? 'var(--muted)', fontWeight: subColor ? 700 : 400 }}>{sub}</div>}
    </div>
  );
}

function SpendHistoryChart({ subscriptionId, fallbackCurrency }: { subscriptionId: string; fallbackCurrency: string }) {
  const [span, setSpan] = useState<number>(SPAN_OPTIONS[0].days);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const viewTo = custom ? custom.to : toISODate(new Date());
  const viewFrom = custom ? custom.from : addDaysIso(viewTo, -(span - 1));
  const viewDays = Math.max(1, Math.round((new Date(viewTo + 'T00:00:00').getTime() - new Date(viewFrom + 'T00:00:00').getTime()) / 86400000) + 1);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    // Fetch well past the visible window: a mid-month start needs the prior
    // day's cumulative value as a baseline (see deltaForWindow), the
    // "vs previous period" comparison needs an equal-length window before
    // that, and doubling covers both with one call.
    const fetchDays = Math.max(viewDays * 2, 1);
    fetch(`/api/cost/history?subscription_id=${subscriptionId}&days=${fetchDays}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setLoading(false); return; }
        setHistory(d);
        setLoading(false);
      })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [subscriptionId, viewFrom, viewTo, viewDays]);

  useEffect(() => { load(); }, [load]);

  const all = useMemo(() => history?.points ?? [], [history]);
  const currency = history?.currency ?? fallbackCurrency;

  const points = useMemo(() => all.filter(p => p.date >= viewFrom && p.date <= viewTo), [all, viewFrom, viewTo]);

  const rangeSpend = useMemo(() => deltaForWindow(all, viewFrom, viewTo), [all, viewFrom, viewTo]);
  const prevSpend = useMemo(() => {
    const prevTo = addDaysIso(viewFrom, -1);
    const prevFrom = addDaysIso(prevTo, -(viewDays - 1));
    return deltaForWindow(all, prevFrom, prevTo);
  }, [all, viewFrom, viewDays]);
  const rangeDelta = prevSpend.total > 0 ? ((rangeSpend.total - prevSpend.total) / prevSpend.total) * 100 : null;
  const dailyAvg = points.length ? rangeSpend.total / points.length : 0;

  return (
    <div className="glass" style={{ borderRadius: 10, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Spend History {history && `— ${history.timeframe === 'MonthToDate' ? 'month-to-date totals, per day' : history.timeframe}`}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {SPAN_OPTIONS.map(opt => (
            <button key={opt.days} onClick={() => { setCustom(null); setSpan(opt.days); }} style={{
              padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 999, cursor: 'pointer',
              background: !custom && span === opt.days ? ACCENT : 'transparent',
              border: `1px solid ${!custom && span === opt.days ? ACCENT : 'var(--border)'}`,
              color: !custom && span === opt.days ? '#fff' : 'var(--muted)',
            }}>
              {opt.label}
            </button>
          ))}
          <button onClick={() => setCustom(c => c ? null : {
            from: toISODate(new Date(Date.now() - 30 * 86400000)),
            to: toISODate(new Date()),
          })} style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 999, cursor: 'pointer',
            background: custom ? ACCENT : 'transparent',
            border: `1px solid ${custom ? ACCENT : 'var(--border)'}`,
            color: custom ? '#fff' : 'var(--muted)',
          }}>
            Custom range
          </button>
        </div>
      </div>

      {custom && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <label style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            From
            <input type="date" value={custom.from} max={custom.to}
              onChange={e => setCustom(c => c && { ...c, from: e.target.value })}
              style={{ fontSize: 11, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '4px 8px' }} />
          </label>
          <label style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            To
            <input type="date" value={custom.to} min={custom.from} max={toISODate(new Date())}
              onChange={e => setCustom(c => c && { ...c, to: e.target.value })}
              style={{ fontSize: 11, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '4px 8px' }} />
          </label>
        </div>
      )}

      {!loading && !error && (
        <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Spent this range</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                {rangeSpend.total.toLocaleString(undefined, { style: 'currency', currency })}
              </span>
              {rangeDelta !== null && (
                <span style={{ fontSize: 11, fontWeight: 700, color: rangeDelta >= 0 ? WARN : GOOD }}>
                  {rangeDelta >= 0 ? '▲' : '▼'} {Math.abs(rangeDelta).toFixed(1)}% vs previous {viewDays}d
                </span>
              )}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Daily average</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {dailyAvg.toLocaleString(undefined, { style: 'currency', currency })}
            </div>
          </div>
        </div>
      )}

      {loading && <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 32 }}>Loading…</div>}

      {!loading && error && (
        <div style={{ fontSize: 12, color: CRIT, textAlign: 'center', padding: 32 }}>⚠ {error}</div>
      )}

      {!loading && !error && points.length < MIN_HISTORY_POINTS && (
        <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--muted)', fontSize: 12 }}>
          Accumulating daily history — check back in a few days.<br />
          <span style={{ fontSize: 11 }}>{points.length} day{points.length === 1 ? '' : 's'} recorded so far.</span>
        </div>
      )}

      {!loading && !error && points.length >= MIN_HISTORY_POINTS && (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={points} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="spendHistoryFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: 'var(--muted)', fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--muted)', fontSize: 9 }} axisLine={false} tickLine={false}
                tickFormatter={v => v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 0 })} />
              <Tooltip
                contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
                labelFormatter={shortDate}
                formatter={(v: number) => [v.toLocaleString(undefined, { style: 'currency', currency }), 'Total cost']}
              />
              <Area type="monotone" dataKey="totalCost" stroke={ACCENT} strokeWidth={2} fill="url(#spendHistoryFill)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}

function BreakdownCard({ title, rows, total, currency, color }: {
  title: string; rows: { name: string; cost: number }[]; total: number; currency: string; color: string;
}) {
  return (
    <div className="glass" style={{ borderRadius: 10, padding: '16px 18px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>{title}</div>
      {rows.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 16 }}>No spend recorded yet this period.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.slice(0, 12).map(r => {
          const share = total > 0 ? (r.cost / total) * 100 : 0;
          return (
            <div key={r.name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.name}</span>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ color: 'var(--muted)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>{share.toFixed(0)}%</span>
                  <span style={{ color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.cost.toLocaleString(undefined, { style: 'currency', currency })}</span>
                </span>
              </div>
              <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.max(share, share > 0 ? 1.5 : 0)}%`, background: color, borderRadius: 2 }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const BACKFILL_MONTHS = 6;
const BACKFILL_POLL_MS = 3000;
const BACKFILL_TIMEOUT_MS = 10 * 60 * 1000; // 6 months, each now retrying up to 5x through Azure throttling — give it real room before assuming it's stuck

function BillingHistoryTable({ subscriptionId, monthlyBudget }: { subscriptionId: string; monthlyBudget: number | null }) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillNote, setBackfillNote] = useState('');
  const [backfillError, setBackfillError] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    // 200 days covers ~6+ calendar months regardless of what span is picked
    // in the chart above — this table isn't tied to that selector. Reads
    // only cached SQLite rows, so there's no rate-limit cost to asking for more.
    fetch(`/api/cost/history?subscription_id=${subscriptionId}&days=200`)
      .then(r => r.json())
      .then(d => { if (!d.error) setHistory(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [subscriptionId]);

  useEffect(() => { reload(); }, [reload]);

  /** Unlike the Refresh button (live MonthToDate), this pulls Azure Cost
   * Management's real *past* months so the table doesn't have to wait weeks
   * to fill in day by day. Safe to click more than once — months that
   * already have a row are skipped server-side without an API call. */
  async function runBackfill() {
    setBackfilling(true);
    setBackfillError('');
    setBackfillNote(`Fetching ${BACKFILL_MONTHS} months of real history from Azure Cost Management — this can take a minute…`);
    try {
      const createRes = await fetch('/api/cost-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId, backfillMonths: BACKFILL_MONTHS }),
      });
      const created = await createRes.json();
      if (!createRes.ok) throw new Error(created.error || 'Could not start the backfill');

      const deadline = Date.now() + BACKFILL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, BACKFILL_POLL_MS));
        const pollRes = await fetch(`/api/cost-requests/${created.id}`);
        const polled = await pollRes.json();
        if (!pollRes.ok) throw new Error(polled.error || 'Could not check backfill status');

        if (polled.status === 'done') {
          setBackfillNote(polled.error_message || `Backfilled ${BACKFILL_MONTHS} months.`);
          reload();
          return;
        }
        if (polled.status === 'failed') {
          throw new Error(polled.error_message || 'Backfill failed');
        }
      }
      throw new Error('Backfill is taking longer than expected — try again in a bit.');
    } catch (e) {
      setBackfillError((e as Error).message);
      setBackfillNote('');
    } finally {
      setBackfilling(false);
    }
  }

  const months = useMemo(() => {
    if (!history) return [];
    const byMonth = new Map<string, HistoryPoint[]>();
    for (const p of history.points) {
      const key = p.date.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(p);
    }
    const keys = [...byMonth.keys()].sort().reverse();
    const thisMonthKey = toISODate(new Date()).slice(0, 7);
    return keys.map((key, i) => {
      const pts = byMonth.get(key)!;
      const total = pts[pts.length - 1].totalCost;
      const prevPts = byMonth.get(keys[i + 1] ?? '');
      const prevTotal = prevPts ? prevPts[prevPts.length - 1].totalCost : null;
      return {
        key,
        label: monthLabel(`${key}-01`),
        total,
        inProgress: key === thisMonthKey,
        change: prevTotal ? ((total - prevTotal) / prevTotal) * 100 : null,
        overBudget: monthlyBudget != null ? total - monthlyBudget : null,
      };
    });
  }, [history, monthlyBudget]);

  if (loading) return null;
  const currency = history?.currency ?? 'USD';
  const DIVIDER = 'rgba(255,255,255,0.08)'; // deliberately softer than var(--border) — a wall of full-strength dividers between 6 rows reads as a spreadsheet, not a dashboard card

  return (
    // .glass — same translucent, blurred panel as BreakdownCard ("By
    // Service"/"By Resource Group") below, so this card matches them instead
    // of sitting there as a flat, mismatched block. An earlier version kept
    // this opaque on the theory that a dense table reads noisy behind glass;
    // in practice that just meant the backdrop-filter blur added for the
    // CursorFX canvas-bleed fix had nothing translucent to actually blur,
    // which is what produced the mismatch.
    <div className="glass" style={{ borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '20px 24px 16px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Billing History
        </div>
        <button onClick={runBackfill} disabled={backfilling} style={{
          marginLeft: 'auto', padding: '5px 12px', fontSize: 11, fontWeight: 700,
          background: 'transparent', border: `1px solid ${ACCENT}`, borderRadius: 3, color: ACCENT,
          cursor: backfilling ? 'default' : 'pointer', opacity: backfilling ? 0.6 : 1,
        }}>
          {backfilling ? '⟳ Fetching real history…' : `↻ Backfill ${BACKFILL_MONTHS} months`}
        </button>
      </div>

      {(backfillNote || backfillError) && (
        <div style={{ padding: '0 24px 16px', fontSize: 11, color: backfillError ? CRIT : 'var(--muted)' }}>
          {backfillError ? `⚠ ${backfillError}` : backfillNote}
        </div>
      )}

      {months.length === 0 ? (
        <div style={{ padding: '8px 24px 28px', fontSize: 12, color: 'var(--muted)' }}>
          No billing history yet — either wait for the daily cost refresh to accumulate real days, or click Backfill above to pull actual past months from Azure Cost Management right now.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
                <th style={{ padding: '0 24px 14px', fontWeight: 700, borderBottom: `1px solid ${DIVIDER}` }}>Month</th>
                <th style={{ padding: '0 24px 14px', fontWeight: 700, textAlign: 'right', borderBottom: `1px solid ${DIVIDER}` }}>Spend</th>
                {monthlyBudget != null && <th style={{ padding: '0 24px 14px', fontWeight: 700, textAlign: 'right', borderBottom: `1px solid ${DIVIDER}` }}>vs budget</th>}
                <th style={{ padding: '0 24px 14px', fontWeight: 700, textAlign: 'right', borderBottom: `1px solid ${DIVIDER}` }}>vs previous</th>
              </tr>
            </thead>
            <tbody>
              {months.map(m => (
                <tr key={m.key} style={{ borderTop: `1px solid ${DIVIDER}` }}>
                  <td style={{ padding: '18px 24px', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                    {m.label}
                    {m.inProgress && (
                      <span style={{ marginLeft: 10, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', background: 'rgba(255,255,255,0.08)', borderRadius: 999, padding: '3px 10px' }}>
                        In progress
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '18px 24px', textAlign: 'right', fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
                    {m.total.toLocaleString(undefined, { style: 'currency', currency })}
                  </td>
                  {monthlyBudget != null && (
                    <td style={{ padding: '18px 24px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: (m.overBudget ?? 0) > 0 ? WARN : GOOD }}>
                      {(m.overBudget ?? 0) > 0 ? '+' : '−'}{Math.abs(m.overBudget ?? 0).toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 0 })}
                    </td>
                  )}
                  <td style={{ padding: '18px 24px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: m.change === null ? 'var(--muted)' : m.change >= 0 ? CRIT : GOOD }}>
                    {m.change === null ? '—' : `${m.change >= 0 ? '▲' : '▼'} ${Math.abs(m.change).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SpendView() {
  const [data, setData] = useState<SpendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    setError('');
    fetch('/api/cost/spend')
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setLoading(false); return; }
        setData(d);
        setLoading(false);
      })
      .catch(e => { setError(String(e)); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  /** This never calls Azure directly — it queues a request that a scheduled
   * Claude Code routine picks up via the MCP server (cmd/mcp.go --http),
   * same mechanism as the AI Assistant's Summarize button. See
   * docs/ai-analysis-routine-setup.md. */
  async function requestRefresh() {
    setRefreshing(true);
    setError('');
    setStatusNote('Queued — waiting for the refresh routine to pick this up…');
    try {
      const createRes = await fetch('/api/cost-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: data?.subscription.id }),
      });
      const created = await createRes.json();
      if (!createRes.ok) throw new Error(created.error || 'Could not queue a cost refresh');

      const deadline = Date.now() + REFRESH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, REFRESH_POLL_MS));
        const pollRes = await fetch(`/api/cost-requests/${created.id}`);
        const polled = await pollRes.json();
        if (!pollRes.ok) throw new Error(polled.error || 'Could not check refresh status');

        if (polled.status === 'done') {
          load();
          return;
        }
        if (polled.status === 'failed') {
          throw new Error(polled.error_message || 'Refresh failed');
        }
      }
      throw new Error('Refresh is taking longer than expected — the routine may not be running.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStatusNote('');
      setRefreshing(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {refreshing ? statusNote : data && !data.noData ? `Last refreshed: ${new Date(data.fetchedAt).toLocaleTimeString()} · Month-to-date` : ''}
        </div>
        <button onClick={requestRefresh} disabled={loading || refreshing} style={{
          marginLeft: 'auto', padding: '5px 12px', fontSize: 11, fontWeight: 700,
          background: 'transparent', border: `1px solid ${ACCENT}`, borderRadius: 3, color: ACCENT, cursor: 'pointer',
        }}>
          {refreshing ? '⟳ Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#FF475718', border: '1px solid #FF475740', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: CRIT }}>
          ⚠ {error}
        </div>
      )}

      {!error && data?.noData && (
        <div className="glass" style={{ borderRadius: 8, padding: '24px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
          {data.message || 'No cost data fetched yet for this subscription.'}<br />
          Click Refresh above to request one.
        </div>
      )}

      {!error && data && !data.noData && (() => {
        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const elapsedDays = now.getDate();
        const forecast = (data.totalCost / elapsedDays) * daysInMonth;
        const overBudget = data.monthlyBudget != null ? forecast - data.monthlyBudget : null;

        return (
        <>
          <div className="glass" style={{ borderRadius: 10, padding: '22px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {data.subscription.name}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: ACCENT, background: `${ACCENT}18`, border: `1px solid ${ACCENT}40`, borderRadius: 999, padding: '2px 9px' }}>
                Month-to-date
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 44, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
                {data.totalCost.toLocaleString(undefined, { style: 'currency', currency: data.currency })}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>spent</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: data.monthlyBudget != null ? '1fr 1fr' : '1fr', gap: 12 }}>
            {data.monthlyBudget != null && (
              <StatTile
                label="Monthly budget"
                value={data.monthlyBudget.toLocaleString(undefined, { style: 'currency', currency: data.currency, maximumFractionDigits: 0 })}
                sub={`${((data.totalCost / data.monthlyBudget) * 100).toFixed(0)}% used so far · ${
                  data.monthlyBudget - data.totalCost >= 0
                    ? `${(data.monthlyBudget - data.totalCost).toLocaleString(undefined, { style: 'currency', currency: data.currency, maximumFractionDigits: 0 })} left`
                    : `${(data.totalCost - data.monthlyBudget).toLocaleString(undefined, { style: 'currency', currency: data.currency, maximumFractionDigits: 0 })} over already`
                }`}
                subColor={data.totalCost > data.monthlyBudget ? WARN : undefined}
              />
            )}
            <StatTile
              label="Forecast this month"
              value={forecast.toLocaleString(undefined, { style: 'currency', currency: data.currency, maximumFractionDigits: 0 })}
              sub={data.monthlyBudget != null
                ? (overBudget! > 0
                  ? `${overBudget!.toLocaleString(undefined, { style: 'currency', currency: data.currency, maximumFractionDigits: 0 })} over budget at this rate`
                  : 'Within budget at this rate')
                : `at the current daily rate, over ${daysInMonth} days`}
              subColor={data.monthlyBudget != null ? (overBudget! > 0 ? WARN : GOOD) : undefined}
            />
          </div>

          <SpendHistoryChart subscriptionId={data.subscription.id} fallbackCurrency={data.currency} />

          <BillingHistoryTable subscriptionId={data.subscription.id} monthlyBudget={data.monthlyBudget} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <BreakdownCard title="By Service" rows={data.byService} total={data.totalCost} currency={data.currency} color={ACCENT} />
            <BreakdownCard title="By Resource Group" rows={data.byResourceGroup} total={data.totalCost} currency={data.currency} color={WARN} />
          </div>

          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
            Cost is measured from Azure Cost Management. This may differ from your final invoice.
          </div>
        </>
        );
      })()}
    </div>
  );
}

export default function CostPage() {
  const [findings, setFindings] = useState<CostFinding[]>([]);
  const [audits, setAudits] = useState<AuditInfo[]>([]);
  const [selectedAudit, setSelectedAudit] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [tab, setTab] = useState<'waste' | 'spend'>('waste');

  useEffect(() => {
    fetch('/api/audits')
      .then(r => r.json())
      .then((list: AuditInfo[]) => {
        const completed = Array.isArray(list) ? list.filter((a: AuditInfo & { status?: string }) => (a as AuditInfo & { status: string }).status === 'completed') : [];
        setAudits(completed);
        if (completed.length > 0) setSelectedAudit(completed[0].id);
      });
  }, []);

  useEffect(() => {
    if (!selectedAudit) return;
    setLoading(true);
    fetch(`/api/findings?audit_id=${selectedAudit}`)
      .then(r => r.json())
      .then((data: CostFinding[]) => {
        const costFindings = Array.isArray(data)
          ? data.filter(f => COST_CATEGORIES.has(f.category))
          : [];
        setFindings(costFindings);
        setLoading(false);
      });
  }, [selectedAudit]);

  const filtered = filter === 'all' ? findings : findings.filter(f => f.severity === filter);

  const critical = findings.filter(f => f.severity === 'Critical').length;
  const warning = findings.filter(f => f.severity === 'Warning').length;
  const info = findings.filter(f => f.severity === 'Info').length;

  // Group by service for breakdown
  const byService: Record<string, number> = {};
  for (const f of findings) {
    byService[f.service] = (byService[f.service] || 0) + 1;
  }
  const serviceEntries = Object.entries(byService).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Topbar */}
        <div className="glass-sb" style={{ borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Cost & Usage</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>Waste, unused resources, and licence inefficiencies</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 3 }}>
              {(['waste', 'spend'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '4px 12px', fontSize: 11, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                  background: tab === t ? 'var(--accent)' : 'transparent',
                  border: `1px solid ${tab === t ? 'var(--accent)' : 'var(--border)'}`,
                  color: tab === t ? '#fff' : 'var(--muted)',
                }}>
                  {t === 'waste' ? 'Waste Findings' : 'Actual Spend'}
                </button>
              ))}
            </div>
            {tab === 'waste' && (
              <>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Audit:</span>
                <select value={selectedAudit} onChange={e => setSelectedAudit(e.target.value)}
                  style={{ fontSize: 11, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '4px 8px' }}>
                  {audits.map(a => (
                    <option key={a.id} value={a.id}>{a.name || a.id.slice(0, 12)}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>

          {tab === 'spend' && <SpendView />}

          {tab === 'waste' && <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {[
              { label: 'Total Cost Issues', value: findings.length, color: ACCENT },
              { label: 'Critical', value: critical, color: CRIT },
              { label: 'Warning', value: warning, color: WARN },
              { label: 'Info', value: info, color: INFO },
            ].map(({ label, value, color }) => (
              <div key={label} className="glass" style={{ borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{label}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 12 }}>

            {/* Service breakdown */}
            <div className="glass" style={{ borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>By Service</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {serviceEntries.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted)' }}>No data</div>}
                {serviceEntries.map(([svc, count]) => (
                  <div key={svc}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--text)' }}>{svc}</span>
                      <span style={{ fontSize: 11, color: ACCENT, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                    </div>
                    <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                      <div style={{ height: '100%', width: `${Math.min(100, (count / (findings.length || 1)) * 100)}%`, background: ACCENT, borderRadius: 2 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Findings table */}
            <div className="glass" style={{ borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Findings</div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
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
              </div>

              {loading && <div style={{ color: 'var(--muted)', fontSize: 12, padding: 16 }}>Loading…</div>}
              {!loading && filtered.length === 0 && (
                <div style={{ color: 'var(--muted)', fontSize: 12, padding: 16, textAlign: 'center' }}>
                  No cost-related findings for this filter.
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {filtered.map(f => (
                  <div key={f.id} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', borderLeft: `3px solid ${sevColor(f.severity)}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: sevColor(f.severity), background: `${sevColor(f.severity)}18`, padding: '1px 6px', borderRadius: 3 }}>{f.severity}</span>
                        <span style={{ fontSize: 10, color: 'var(--muted)', background: 'var(--card)', padding: '1px 6px', borderRadius: 3, border: '1px solid var(--border)' }}>{f.service}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{f.category}</span>
                      </div>
                      {f.resource && <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>{f.resource}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>{f.description}</div>
                    {f.recommendation && (
                      <div style={{ fontSize: 10, color: ACCENT, marginTop: 4, lineHeight: 1.4 }}>→ {f.recommendation}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          </>}
        </div>
      </div>
    </div>
  );
}
