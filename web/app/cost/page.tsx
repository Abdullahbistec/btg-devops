'use client';
import { Fragment, useEffect, useState, useMemo, useCallback } from 'react';
import Sidebar from '@/components/Sidebar';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { resourceGroupLabel } from '@/lib/cost-labels';

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

function weekdayDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function monthLabel(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'long' });
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
      // A baseline is only valid within the same calendar month as `cursor`
      // — MTD resets to 0 on the 1st, so a prior month's end-of-month total
      // (e.g. a backfilled row) is not "the value right before this point,"
      // it's a different month's cumulative total entirely. Using it as a
      // baseline here previously made endTotal - baseTotal deeply negative
      // whenever real data for the current month started partway through
      // (e.g. a mid-month subscription start), clamping the whole window's
      // total to 0 via Math.max(0, ...) below.
      if (before && before.date.slice(0, 7) === cursor.slice(0, 7)) {
        baseTotal = before.totalCost; baseService = toServiceMap(before.byService);
      }
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

// Comfortably covers several past years of billing history for the year
// filter below — reads only cached rows (no Azure rate-limit cost), so
// there's no reason to size this tightly to the current backfill window.
const HISTORY_DAYS = 1500;

function BillingHistoryTable({ subscriptionId, monthlyBudget }: { subscriptionId: string; monthlyBudget: number | null }) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillNote, setBackfillNote] = useState('');
  const [backfillError, setBackfillError] = useState('');
  const [selectedYear, setSelectedYear] = useState(() => String(new Date().getFullYear()));

  const reload = useCallback(() => {
    setLoading(true);
    fetch(`/api/cost/history?subscription_id=${subscriptionId}&days=${HISTORY_DAYS}`)
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
    // "vs previous" above is computed against the full, unfiltered month
    // list (so January's comparison reaches back into December of the prior
    // year) — the year filter below only narrows what's *displayed*.
  }, [history, monthlyBudget]);

  // Every year that has at least one month of data, plus the current year
  // even before any data exists for it, so the selector is never empty.
  const years = useMemo(() => {
    const set = new Set(months.map(m => m.key.slice(0, 4)));
    set.add(String(new Date().getFullYear()));
    return [...set].sort().reverse();
  }, [months]);

  const visibleMonths = useMemo(
    () => months.filter(m => m.key.startsWith(selectedYear)),
    [months, selectedYear]
  );

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
        <select value={selectedYear} onChange={e => setSelectedYear(e.target.value)} style={{
          fontSize: 11, fontWeight: 700, background: 'var(--card)', border: '1px solid var(--border)',
          color: 'var(--text)', borderRadius: 3, padding: '5px 8px', cursor: 'pointer',
        }}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
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
      ) : visibleMonths.length === 0 ? (
        <div style={{ padding: '8px 24px 28px', fontSize: 12, color: 'var(--muted)' }}>
          No billing history for {selectedYear}. Try a different year, or click Backfill above to pull more real months from Azure Cost Management.
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
              {visibleMonths.map(m => (
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

interface HetznerResourceLine {
  name: string; type: string; location: string;
  count: number; unit: string; unit_price: number; monthly: number;
}

interface HetznerSpend {
  totalMonthly: number; currency: string;
  byCategory: Record<string, number>; byType: Record<string, { count: number; monthly_total: number }>;
  unpriced?: string[];
  resources?: HetznerResourceLine[];
  fetchedAt: string; noData?: boolean; message?: string;
  error?: string;
}

const UNPRICED_PREVIEW_COUNT = 3;
const HETZNER_MONTHLY_HOURS = 624;

interface HetznerHistoryPoint { day: string; total_monthly: number; currency: string; reconstructed: boolean }
interface HetznerChangeEvent { day: string; description: string; delta: number; new_rate: number }

/** Run-rate over time — deliberately NOT "spend history".
 *
 * Azure's chart plots what was spent, and it moves as resources are consumed.
 * This plots what the infrastructure costs per month as measured each day: it
 * is flat while the fleet is unchanged and steps when a server or volume is
 * added or removed. Labelling it "spend" would repeat exactly the
 * billed-vs-estimated confusion the rest of this view works to avoid.
 *
 * It also cannot be backfilled — Hetzner exposes no spend history — so the
 * line starts the day the first snapshot was taken and fills in from there.
 * Below MIN_HISTORY_POINTS it shows the same honest placeholder the Azure
 * chart uses rather than a near-empty chart that reads as broken. */
function HetznerRunRateChart({ fallbackCurrency }: { fallbackCurrency: string }) {
  const [span, setSpan] = useState<number>(SPAN_OPTIONS[0].days);
  const [points, setPoints] = useState<HetznerHistoryPoint[]>([]);
  const [events, setEvents] = useState<HetznerChangeEvent[]>([]);
  const [currency, setCurrency] = useState(fallbackCurrency);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [backfilling, setBackfilling] = useState(false);
  const [backfillNote, setBackfillNote] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    fetch(`/api/cost/hetzner/history?days=${span}`)
      .then(r => r.json())
      .then(d => {
        if (d?.error) { setError(d.error); setLoading(false); return; }
        setPoints(Array.isArray(d?.points) ? d.points : []);
        setEvents(Array.isArray(d?.events) ? d.events : []);
        if (d?.currency) setCurrency(d.currency);
        setLoading(false);
      })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [span]);

  useEffect(() => { load(); }, [load]);

  async function runBackfill() {
    setBackfilling(true);
    setBackfillNote('');
    try {
      const res = await fetch('/api/cost/hetzner/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: span }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Backfill failed');
      setBackfillNote(`Reconstructed ${body.reconstructed} day(s) from resource creation dates.`);
      load();
    } catch (e) {
      setBackfillNote(`⚠ ${(e as Error).message}`);
    } finally {
      setBackfilling(false);
    }
  }

  const reconstructedCount = points.filter(p => p.reconstructed).length;

  // Step change across the window — the meaningful delta for a run rate is
  // "did the fleet get more expensive", not a sum of daily values.
  const first = points[0]?.total_monthly;
  const last = points[points.length - 1]?.total_monthly;
  const deltaAbs = first != null && last != null ? last - first : null;
  const delta = first && last && first > 0 ? ((last - first) / first) * 100 : null;

  // This is a step function (flat until a server/volume/IP is added or
  // removed), so a Y axis anchored at $0 crushes a real change into a
  // near-invisible wobble. Zoom to the data's own range instead, and mark
  // the exact days the rate actually stepped — those are the only points
  // that matter on a series that is otherwise flat by construction.
  const values = points.map(p => p.total_monthly);
  const minVal = values.length ? Math.min(...values) : 0;
  const maxVal = values.length ? Math.max(...values) : 0;
  const pad = Math.max((maxVal - minVal) * 0.2, maxVal * 0.03, 1);
  const yDomain: [number, number] = [Math.max(0, minVal - pad), maxVal + pad];

  function ChangeDot(props: { cx?: number; cy?: number; index?: number }) {
    const { cx, cy, index } = props;
    if (cx == null || cy == null || index == null) return null;
    // The most recent point is always marked, in a neutral color, as "this
    // is now" — distinct from the orange/green dots that mark which earlier
    // days actually moved the rate.
    if (index === points.length - 1) {
      return <circle cx={cx} cy={cy} r={4.5} fill={ACCENT} stroke="var(--card)" strokeWidth={1.5} />;
    }
    if (index === 0) return null;
    const prev = points[index - 1];
    const cur = points[index];
    if (!prev || !cur || prev.total_monthly === cur.total_monthly) return null;
    const up = cur.total_monthly > prev.total_monthly;
    return <circle cx={cx} cy={cy} r={4} fill={up ? WARN : GOOD} stroke="var(--card)" strokeWidth={1.5} />;
  }

  return (
    <div className="glass" style={{ borderRadius: 10, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Run Rate History — monthly rate, as measured each day
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {SPAN_OPTIONS.map(opt => (
            <button key={opt.days} onClick={() => setSpan(opt.days)} style={{
              padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 999, cursor: 'pointer',
              background: span === opt.days ? ACCENT : 'transparent',
              border: `1px solid ${span === opt.days ? ACCENT : 'var(--border)'}`,
              color: span === opt.days ? '#fff' : 'var(--muted)',
            }}>
              {opt.label}
            </button>
          ))}
          <button onClick={runBackfill} disabled={backfilling} style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 999,
            background: 'transparent', border: `1px solid ${ACCENT}`, color: ACCENT,
            cursor: backfilling ? 'default' : 'pointer', opacity: backfilling ? 0.6 : 1,
          }}>
            {backfilling ? '⟳ Reconstructing…' : '↻ Reconstruct history'}
          </button>
        </div>
      </div>

      {backfillNote && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>{backfillNote}</div>
      )}

      {/* The reconstructed-days caveat banner was removed at the owner's
          request. The distinction still exists in the data — each point
          carries `reconstructed`, and the API returns it — so it can be
          surfaced again (as a quieter footnote, or per-point in the tooltip)
          without any backend change. */}

      {!loading && !error && last != null && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 16, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Current run rate</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {last.toLocaleString(undefined, { style: 'currency', currency })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Change across range</div>
            <div style={{ marginTop: 2 }}>
              {delta !== null && Math.abs(delta) >= 0.01 ? (
                <span style={{ fontSize: 15, fontWeight: 700, color: delta >= 0 ? WARN : GOOD }}>
                  {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(2)}% ({deltaAbs != null && deltaAbs >= 0 ? '+' : ''}{deltaAbs?.toLocaleString(undefined, { style: 'currency', currency })})
                </span>
              ) : (
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--muted)' }}>No change</span>
              )}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Range low / high</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {minVal.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 })} – {maxVal.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Changes in range</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {events.length}
            </div>
          </div>
        </div>
      )}

      {loading && <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 32 }}>Loading…</div>}
      {!loading && error && <div style={{ fontSize: 12, color: CRIT, textAlign: 'center', padding: 32 }}>⚠ {error}</div>}

      {!loading && !error && points.length < MIN_HISTORY_POINTS && (
        <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--muted)', fontSize: 12 }}>
          Accumulating run-rate history — check back in a few days.<br />
          <span style={{ fontSize: 11 }}>
            {points.length} day{points.length === 1 ? '' : 's'} recorded so far. Hetzner exposes no spend history, so this cannot be backfilled.
          </span>
        </div>
      )}

      {!loading && !error && points.length >= MIN_HISTORY_POINTS && (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={points} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="hetznerRunRateFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="day" tickFormatter={shortDate} tick={{ fill: 'var(--muted)', fontSize: 9 }} axisLine={false} tickLine={false} />
            <YAxis domain={yDomain} tick={{ fill: 'var(--muted)', fontSize: 9 }} axisLine={false} tickLine={false}
              tickFormatter={v => v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 0 })} />
            <Tooltip
              contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
              labelFormatter={shortDate}
              formatter={(v: number) => [v.toLocaleString(undefined, { style: 'currency', currency }), 'Run rate/mo']}
            />
            <Area type="stepAfter" dataKey="total_monthly" stroke={ACCENT} strokeWidth={2} fill="url(#hetznerRunRateFill)" dot={<ChangeDot />} />
          </AreaChart>
        </ResponsiveContainer>
      )}

      {!loading && !error && points.length >= MIN_HISTORY_POINTS && (
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 10.5, color: 'var(--muted)' }}>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: WARN, marginRight: 5 }} />Rate increased</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: GOOD, marginRight: 5 }} />Rate decreased</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: ACCENT, marginRight: 5 }} />Current</span>
        </div>
      )}

      {!loading && !error && events.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            What changed
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Date</th>
                  <th style={{ padding: '4px 8px', fontWeight: 600 }}>What changed</th>
                  <th style={{ padding: '4px 8px', fontWeight: 600, textAlign: 'right' }}>Delta</th>
                  <th style={{ padding: '4px 0 4px 8px', fontWeight: 600, textAlign: 'right' }}>New run rate</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev, i) => (
                  <tr key={`${ev.day}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '7px 8px 7px 0', color: 'var(--text)', whiteSpace: 'nowrap' }}>{weekdayDate(ev.day)}</td>
                    <td style={{ padding: '7px 8px', color: 'var(--text)' }}>{ev.description}</td>
                    <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: ev.delta >= 0 ? WARN : GOOD, whiteSpace: 'nowrap' }}>
                      {ev.delta >= 0 ? '+' : ''}{ev.delta.toLocaleString(undefined, { style: 'currency', currency })}
                    </td>
                    <td style={{ padding: '7px 0 7px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                      {ev.new_rate.toLocaleString(undefined, { style: 'currency', currency })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function HetznerSpendView() {
  const [data, setData] = useState<HetznerSpend | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinct from `data === null` (still loading) and `data.noData` (a
  // legitimate "no snapshot yet" state) — a fetch rejection or the route's
  // own {error} 500 shape must render as a visible failure, not silently
  // fall through to Object.entries(undefined) and crash the component.
  const [fetchError, setFetchError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setFetchError('');
    fetch('/api/cost/hetzner')
      .then(r => r.json().then(d => ({ ok: r.ok, body: d })))
      .then(({ ok, body }) => {
        if (!ok || body?.error) {
          setFetchError(body?.error || 'Failed to load Hetzner cost data.');
          setData(null);
        } else {
          setData(body);
        }
        setLoading(false);
      })
      .catch(e => { setFetchError(String(e)); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  // The Hetzner refresh completes synchronously in-process (see
  // /api/cost-requests's provider:'hetzner' branch) — no polling needed,
  // unlike the Azure Refresh button which waits on a queued request.
  async function requestRefresh() {
    setRefreshing(true);
    setRefreshError('');
    try {
      const res = await fetch('/api/cost-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'hetzner' }),
      });
      const body = await res.json();
      if (!res.ok || body?.error) throw new Error(body?.error || 'Could not refresh Hetzner cost data');
      load();
    } catch (e) {
      setRefreshError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  const refreshButton = (
    <button onClick={requestRefresh} disabled={refreshing} style={{
      padding: '5px 12px', fontSize: 11, fontWeight: 700,
      background: 'transparent', border: `1px solid ${ACCENT}`, borderRadius: 3, color: ACCENT,
      cursor: refreshing ? 'default' : 'pointer', opacity: refreshing ? 0.6 : 1,
    }}>
      {refreshing ? '⟳ Refreshing…' : '↻ Refresh'}
    </button>
  );

  if (loading) return <div style={{ fontSize: 12, color: 'var(--muted)', padding: 32 }}>Loading…</div>;

  if (fetchError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: '#FF475718', border: '1px solid #FF475740', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: CRIT }}>
          ⚠ {fetchError}
        </div>
        {refreshError && (
          <div style={{ background: '#FF475718', border: '1px solid #FF475740', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: CRIT }}>
            ⚠ {refreshError}
          </div>
        )}
        <div>{refreshButton}</div>
      </div>
    );
  }

  if (!data || data.noData) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="glass" style={{ borderRadius: 8, padding: '24px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
          {data?.message ?? 'No Hetzner cost snapshot yet.'}
        </div>
        {refreshError && (
          <div style={{ background: '#FF475718', border: '1px solid #FF475740', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: CRIT }}>
            ⚠ {refreshError}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'center' }}>{refreshButton}</div>
      </div>
    );
  }

  const cat = Object.entries(data.byCategory).map(([name, cost]) => ({ name, cost }));
  const types = Object.entries(data.byType).map(([name, v]) => ({ name: `${name} x${v.count}`, cost: v.monthly_total }));
  // "By Server Type" rows only ever sum to the servers subtotal (volumes and
  // primary IPs aren't server types) — using the grand total as the
  // denominator here previously made every share read low and the column
  // never reach 100%.
  const serversSubtotal = data.byCategory.servers ?? 0;
  const unpriced = data.unpriced ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{refreshButton}</div>
      {refreshError && (
        <div style={{ background: '#FF475718', border: '1px solid #FF475740', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: CRIT }}>
          ⚠ {refreshError}
        </div>
      )}
      <div className="glass" style={{ borderRadius: 10, padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
            {data.totalMonthly.toLocaleString(undefined, { style: 'currency', currency: data.currency })}
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)', marginLeft: 8 }}>/month</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
            ≈ {(data.totalMonthly / HETZNER_MONTHLY_HOURS).toLocaleString(undefined, { style: 'currency', currency: data.currency, maximumFractionDigits: 4 })}/hour
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
          Estimated from list prices
        </div>
        <div style={{
          marginTop: 14, padding: '10px 14px', borderRadius: 6,
          background: '#54A0FF18', border: '1px solid #54A0FF40', color: INFO,
          fontSize: 12, lineHeight: 1.5,
        }}>
          ⓘ Not a bill — Hetzner exposes no invoice or spend-history endpoint.
          This is a monthly run-rate estimate: what today&apos;s servers, volumes,
          and primary IPs would cost for a full month at current list prices in
          {' '}{data.currency}, the currency Hetzner itself reports for this
          account. The chart below re-prices that same estimate for each past
          day — it moves only when a resource is added or removed, not from
          actual usage.
        </div>
        {unpriced.length > 0 && (
          // Deliberately loud, not a tooltip: a pricing miss must never look
          // like a legitimate $0 — the total above is understated by
          // whatever these resources would have cost.
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 6,
            background: '#FF475718', border: '1px solid #FF475740', color: CRIT,
            fontSize: 12, lineHeight: 1.5,
          }}>
            ⚠ {unpriced.length} resource{unpriced.length === 1 ? '' : 's'} could not be priced and {unpriced.length === 1 ? 'is' : 'are'} excluded from the total above — the true run rate is higher than shown.
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {unpriced.slice(0, UNPRICED_PREVIEW_COUNT).map((u, i) => <li key={i}>{u}</li>)}
              {unpriced.length > UNPRICED_PREVIEW_COUNT && (
                <li>…and {unpriced.length - UNPRICED_PREVIEW_COUNT} more</li>
              )}
            </ul>
          </div>
        )}
      </div>
      <HetznerRunRateChart fallbackCurrency={data.currency} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <BreakdownCard title="By Category" rows={cat} total={data.totalMonthly} currency={data.currency} color={ACCENT} />
        <BreakdownCard title="By Server Type" rows={types} total={serversSubtotal} currency={data.currency} color={WARN} />
      </div>
      {data.resources && data.resources.length > 0 && (
        <HetznerReconciliationTable resources={data.resources} currency={data.currency} total={data.totalMonthly} />
      )}
      <HetznerBillingFacts currency={data.currency} />
      <HetznerInvoicesView />
    </div>
  );
}

interface HetznerInvoice { id: string; invoice_number: string; invoice_date: string; total: number; currency: string; scraped_at: string }

/** Real invoice totals, scraped from the Hetzner account Console rather than
 * the (invoice-less) Cloud API — see web/lib/hetznerInvoiceScrape.ts's
 * module doc for the full tradeoff this represents. Admin-only in both
 * directions (view and trigger): this is meaningfully more sensitive than
 * the rest of the Hetzner cost view, which only ever touches the scoped,
 * read-only HCLOUD_TOKEN. */
function HetznerInvoicesView() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [checked, setChecked] = useState(false);
  const [invoices, setInvoices] = useState<HetznerInvoice[]>([]);
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState('');

  const load = useCallback(() => {
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(me => {
      setIsAdmin(me?.role === 'admin');
      setChecked(true);
      if (me?.role !== 'admin') return;
      fetch('/api/cost/hetzner/invoices').then(r => r.ok ? r.json() : { invoices: [] })
        .then(d => setInvoices(Array.isArray(d?.invoices) ? d.invoices : []))
        .catch(() => {});
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runScrape() {
    setScraping(true);
    setScrapeError('');
    try {
      const res = await fetch('/api/cost/hetzner/invoices', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || body?.error) throw new Error(body?.error || 'Scrape failed');
      load();
    } catch (e) {
      setScrapeError((e as Error).message);
    } finally {
      setScraping(false);
    }
  }

  if (!checked || !isAdmin) return null;

  return (
    <div className="glass" style={{ borderRadius: 10, padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Actual invoices (scraped)
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Real billed totals from the Hetzner account Console — not the estimate above.
          </div>
        </div>
        <button onClick={runScrape} disabled={scraping} style={{
          padding: '5px 12px', fontSize: 11, fontWeight: 700,
          background: 'transparent', border: `1px solid ${ACCENT}`, borderRadius: 3, color: ACCENT,
          cursor: scraping ? 'default' : 'pointer', opacity: scraping ? 0.6 : 1,
        }}>
          {scraping ? '⟳ Logging in…' : '↻ Scrape now'}
        </button>
      </div>

      <div style={{
        padding: '10px 14px', borderRadius: 6, marginBottom: 12,
        background: '#FF475718', border: '1px solid #FF475740', color: CRIT,
        fontSize: 11.5, lineHeight: 1.5,
      }}>
        ⚠ This logs into the real Hetzner account with a stored password, unverified against the live site, and
        limited to one attempt per 24h — a deliberate deviation from this project&apos;s own ADR-001/ADR-006. Does not
        work if 2FA is enabled on the account.
      </div>

      {scrapeError && (
        <div style={{ background: '#FF475718', border: '1px solid #FF475740', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: CRIT, marginBottom: 12 }}>
          ⚠ {scrapeError}
        </div>
      )}

      {invoices.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>No invoices scraped yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Invoice</th>
                <th style={{ padding: '4px 8px', fontWeight: 600 }}>Date</th>
                <th style={{ padding: '4px 0 4px 8px', fontWeight: 600, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px 6px 0', color: 'var(--text)' }}>{inv.invoice_number}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{shortDate(inv.invoice_date)}</td>
                  <td style={{ padding: '6px 0 6px 8px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {inv.total.toLocaleString(undefined, { style: 'currency', currency: inv.currency })}
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

/** Every priced resource, its own unit price, its own monthly cost — the
 * detail behind the By Category / By Server Type rollups above. Exists so a
 * reader can check the headline figure foots up from real resources instead
 * of taking the total on faith. */
function HetznerReconciliationTable({ resources, currency, total }: { resources: HetznerResourceLine[]; currency: string; total: number }) {
  const grouped: Record<string, HetznerResourceLine[]> = { 'Cloud servers': [], 'Network': [], 'Storage': [] };
  for (const r of resources) {
    if (r.type === 'volume') grouped.Storage.push(r);
    else if (r.type.startsWith('ipv')) grouped.Network.push(r);
    else grouped['Cloud servers'].push(r);
  }
  return (
    <div className="glass" style={{ borderRadius: 10, padding: '18px 20px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
        How the figure is built
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>Every resource in the project, at its list price.</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Resource</th>
              <th style={{ padding: '4px 8px', fontWeight: 600 }}>Type</th>
              <th style={{ padding: '4px 8px', fontWeight: 600 }}>Location</th>
              <th style={{ padding: '4px 8px', fontWeight: 600, textAlign: 'right' }}>Count</th>
              <th style={{ padding: '4px 8px', fontWeight: 600, textAlign: 'right' }}>Unit price</th>
              <th style={{ padding: '4px 0 4px 8px', fontWeight: 600, textAlign: 'right' }}>{currency} / month</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(grouped).filter(([, rows]) => rows.length > 0).map(([group, rows]) => (
              <Fragment key={group}>
                <tr>
                  <td colSpan={6} style={{ padding: '8px 8px 4px 0', fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{group}</td>
                </tr>
                {rows.map((r, i) => (
                  <tr key={`${r.name}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px 6px 0', color: 'var(--text)' }}>{r.name}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{r.type}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{r.location}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.count}{r.unit === 'GB' ? ' GB' : ''}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>
                      {r.unit_price.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: r.unit_price < 1 ? 4 : 2 })}{r.unit === 'GB' ? '/GB' : '/mo'}
                    </td>
                    <td style={{ padding: '6px 0 6px 8px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {r.monthly.toLocaleString(undefined, { style: 'currency', currency })}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} style={{ padding: '10px 8px 0 0', fontWeight: 700, borderTop: '2px solid var(--border)' }}>Monthly run rate</td>
              <td style={{ padding: '10px 0 0 8px', textAlign: 'right', fontWeight: 700, color: ACCENT, borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>
                {total.toLocaleString(undefined, { style: 'currency', currency })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function HetznerBillingFacts({ currency }: { currency: string }) {
  const qa: [string, string][] = [
    ['Which dollar?', `${currency} — read straight from Hetzner's own Cloud API pricing response for this account. Hetzner bills only in EUR or USD; it never bills in AUD.`],
    ['Monthly or daily?', 'Monthly. The chart above re-prices that same monthly figure for each past day — it is not a daily spend total.'],
    ['Where does the number come from?', "Hetzner's live pricing endpoint, multiplied by the resources actually in this account, summed — the same figure the reconciliation table above foots to."],
    ['When does Hetzner actually charge?', 'Hourly, rounded up, capped at 624 hours per month, invoiced monthly in arrears.'],
    ['Will the invoice match this?', 'It will usually be lower — anything created mid-month is billed only from its creation hour, and Hetzner exposes no invoice endpoint this tool can check against.'],
  ];
  return (
    <div className="glass" style={{ borderRadius: 10, padding: '18px 20px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
        Billing facts
      </div>
      <dl style={{ margin: 0 }}>
        {qa.map(([q, a]) => (
          <div key={q} style={{ marginTop: 10 }}>
            <dt style={{ fontSize: 12.5, color: 'var(--muted)' }}>{q}</dt>
            <dd style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>{a}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// EU (Germany/Finland) Hetzner Cloud list prices, confirmed against Hetzner's
// own 15 Jun 2026 price-adjustment page — the same verified figures used in
// the standalone Hetzner Cost Estimator artifact. [sku, vCPU, RAM GB, disk GB, EUR/mo, USD/mo]
const K3S_EU_CATALOG: [string, number, number, number, number, number][] = [
  ['CX23', 2, 4, 40, 5.49, 6.49],
  ['CX33', 4, 8, 80, 8.49, 9.99],
  ['CX43', 8, 16, 160, 15.99, 18.49],
  ['CX53', 16, 32, 320, 29.49, 34.99],
  ['CPX22', 2, 4, 80, 19.49, 22.99],
  ['CPX32', 4, 8, 160, 35.49, 41.99],
  ['CPX42', 8, 16, 240, 69.49, 81.99],
  ['CCX13', 2, 8, 80, 42.99, 50.49],
  ['CCX23', 4, 16, 160, 85.99, 101.49],
  ['CCX33', 8, 32, 240, 138.49, 162.99],
];

interface PlanLine { id: string; sku: string; qty: number }
interface PlanGroup { id: string; name: string; lines: PlanLine[] }
const PLAN_KEY = 'hetzner-plan-v1';

// Shape mirrors the consolidation plan: a shared cluster for dev/UAT, and a
// separate cluster per production workload. Starts empty — node counts are
// whatever gets agreed in the walkthrough, not something to guess here.
function defaultPlan(): PlanGroup[] {
  return [
    { id: 'devuat', name: 'Dev/UAT — shared K3s cluster', lines: [] },
    { id: 'prod', name: 'Production — dedicated cluster', lines: [] },
  ];
}

function findSku(sku: string) {
  return K3S_EU_CATALOG.find(r => r[0] === sku) ?? K3S_EU_CATALOG[0];
}

function HetznerPlanView() {
  const [groups, setGroups] = useState<PlanGroup[]>(defaultPlan);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLAN_KEY);
      if (raw) setGroups(JSON.parse(raw));
    } catch { /* private browsing / storage blocked — start from defaults */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(groups)); } catch { /* best-effort only */ }
  }, [groups, loaded]);

  function addLine(gid: string) {
    setGroups(gs => gs.map(g => g.id === gid
      ? { ...g, lines: [...g.lines, { id: `${Date.now()}-${g.lines.length}`, sku: K3S_EU_CATALOG[0][0], qty: 1 }] }
      : g));
  }
  function updateLine(gid: string, lid: string, patch: Partial<PlanLine>) {
    setGroups(gs => gs.map(g => g.id === gid
      ? { ...g, lines: g.lines.map(l => l.id === lid ? { ...l, ...patch } : l) }
      : g));
  }
  function removeLine(gid: string, lid: string) {
    setGroups(gs => gs.map(g => g.id === gid ? { ...g, lines: g.lines.filter(l => l.id !== lid) } : g));
  }
  function addGroup() {
    setGroups(gs => [...gs, { id: `${Date.now()}`, name: `Cluster ${gs.length + 1}`, lines: [] }]);
  }
  function renameGroup(gid: string, name: string) {
    setGroups(gs => gs.map(g => g.id === gid ? { ...g, name } : g));
  }
  function removeGroup(gid: string) {
    setGroups(gs => gs.filter(g => g.id !== gid));
  }

  function groupMonthly(g: PlanGroup, usd: boolean) {
    return g.lines.reduce((sum, l) => sum + findSku(l.sku)[usd ? 5 : 4] * l.qty, 0);
  }
  const totalEur = groups.reduce((s, g) => s + groupMonthly(g, false), 0);
  const totalUsd = groups.reduce((s, g) => s + groupMonthly(g, true), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        padding: '10px 14px', borderRadius: 6, background: '#54A0FF18', border: '1px solid #54A0FF40',
        color: INFO, fontSize: 12, lineHeight: 1.5,
      }}>
        ⓘ A projection, not live data — size the servers a proposed setup would need and see the
        monthly run rate before anything is provisioned. Pricing is Hetzner&apos;s EU (Germany/Finland)
        cloud list. Saved only in this browser, per the same offline-first approach as the standalone
        estimator.
      </div>

      <div className="glass" style={{ borderRadius: 10, padding: '22px 24px' }}>
        <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
          {totalEur.toLocaleString(undefined, { style: 'currency', currency: 'EUR' })}
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)', marginLeft: 8 }}>/month</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
          ≈ {totalUsd.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}/month · compute only — excludes volumes, IPv4, backups, egress and VAT. For those, use the standalone Hetzner Cost Estimator.
        </div>
      </div>

      {groups.map(g => {
        const gTotal = groupMonthly(g, false);
        return (
          <div key={g.id} className="glass" style={{ borderRadius: 10, padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <input value={g.name} onChange={e => renameGroup(g.id, e.target.value)} aria-label="Cluster name" style={{
                background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                color: 'var(--text)', fontSize: 14, fontWeight: 700, padding: '2px 0', flex: 1, minWidth: 160,
              }} />
              <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, fontVariantNumeric: 'tabular-nums' }}>
                {gTotal.toLocaleString(undefined, { style: 'currency', currency: 'EUR' })}/mo
              </div>
              <button onClick={() => removeGroup(g.id)} style={{
                background: 'transparent', border: 'none', color: CRIT, cursor: 'pointer', fontSize: 12,
              }}>Remove cluster</button>
            </div>
            {g.lines.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>No nodes added yet.</div>
            )}
            {g.lines.map(l => {
              const r = findSku(l.sku);
              return (
                <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 12, flexWrap: 'wrap' }}>
                  <select value={l.sku} onChange={e => updateLine(g.id, l.id, { sku: e.target.value })} style={{
                    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 6px',
                  }}>
                    {K3S_EU_CATALOG.map(row => (
                      <option key={row[0]} value={row[0]}>
                        {row[0]} — {row[1]} vCPU / {row[2]}GB — €{row[4]}/mo
                      </option>
                    ))}
                  </select>
                  <span style={{ color: 'var(--muted)' }}>×</span>
                  <input type="number" min={1} value={l.qty} onChange={e => updateLine(g.id, l.id, { qty: Math.max(1, parseInt(e.target.value || '1', 10)) })} style={{
                    width: 56, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 6px',
                  }} />
                  <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {(r[4] * l.qty).toLocaleString(undefined, { style: 'currency', currency: 'EUR' })}/mo
                  </span>
                  <button onClick={() => removeLine(g.id, l.id)} aria-label={`Remove ${l.sku}`} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>×</button>
                </div>
              );
            })}
            <button onClick={() => addLine(g.id)} style={{
              marginTop: 6, padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 3,
              background: 'transparent', border: `1px solid ${ACCENT}`, color: ACCENT, cursor: 'pointer',
            }}>+ Add node</button>
          </div>
        );
      })}

      <button onClick={addGroup} style={{
        alignSelf: 'flex-start', padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 4,
        background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer',
      }}>+ Add cluster</button>
    </div>
  );
}

function SpendView() {
  const [data, setData] = useState<SpendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const [error, setError] = useState('');
  const [provider, setProvider] = useState<'azure' | 'hetzner'>('azure');
  const [hetznerMode, setHetznerMode] = useState<'current' | 'planned'>('current');

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

  /** POST /api/cost-requests processes this synchronously, in the same
   * request — it calls Azure Cost Management directly server-side, no MCP
   * server or scheduled Claude Code routine involved (see that route's own
   * comment). The polling loop below still exists because the endpoint
   * returns 202 with a request id rather than the result inline, and as a
   * safety net if a request is ever left pending for some other reason. */
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
      <div style={{ display: 'flex', gap: 3, marginBottom: 12 }}>
        {(['azure', 'hetzner'] as const).map(p => (
          <button key={p} onClick={() => setProvider(p)} style={{
            padding: '4px 12px', fontSize: 11, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
            background: provider === p ? 'var(--accent)' : 'transparent',
            border: `1px solid ${provider === p ? 'var(--accent)' : 'var(--border)'}`,
            color: provider === p ? '#fff' : 'var(--muted)',
          }}>
            {p === 'azure' ? 'Azure' : 'Hetzner'}
          </button>
        ))}
      </div>

      {provider === 'azure' && (
      <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {refreshing ? statusNote : data && !data.noData ? `Last refreshed: ${new Date(data.fetchedAt).toLocaleDateString()} ${new Date(data.fetchedAt).toLocaleTimeString()} · Month-to-date` : ''}
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
            <BreakdownCard title="By Resource Group" rows={data.byResourceGroup.map(r => ({ ...r, name: resourceGroupLabel(r.name) }))} total={data.totalCost} currency={data.currency} color={WARN} />
          </div>

          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
            Cost is measured from Azure Cost Management. This may differ from your final invoice.
          </div>
        </>
        );
      })()}
      </>
      )}

      {provider === 'hetzner' && (
        <>
          <div style={{ display: 'flex', gap: 3, marginBottom: 12 }}>
            {(['current', 'planned'] as const).map(m => (
              <button key={m} onClick={() => setHetznerMode(m)} style={{
                padding: '4px 12px', fontSize: 11, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
                background: hetznerMode === m ? ACCENT : 'transparent',
                border: `1px solid ${hetznerMode === m ? ACCENT : 'var(--border)'}`,
                color: hetznerMode === m ? '#fff' : 'var(--muted)',
              }}>
                {m === 'current' ? 'Current' : 'Planned (consolidation)'}
              </button>
            ))}
          </div>
          {hetznerMode === 'current' ? <HetznerSpendView /> : <HetznerPlanView />}
        </>
      )}
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
