import { getDB, getSubscription, saveCostSnapshot, saveCostSnapshotHistoryRow, hasCostSnapshotHistoryRow } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';

interface CostRow {
  cost: number;
  service: string;
  resourceGroup: string;
  currency: string;
}

export interface CostPayload {
  subscription: { id: string; name: string };
  timeframe: string;
  totalCost: number;
  currency: string;
  byService: { name: string; cost: number }[];
  byResourceGroup: { name: string; cost: number }[];
  fetchedAt: string;
}

// Cost Management's own rate limit is notoriously tight (tenant-wide, shared
// across every caller). Retries both a clean 429 response AND a thrown
// network error (connection reset, DNS blip, Azure dropping the connection
// under load instead of returning 429 cleanly — "fetch failed" is Node's
// exact message for that second case, and it bypasses a status-code-only
// retry entirely), honoring Retry-After when Azure sends one.
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 || attempt === maxAttempts) return res;
      const retryAfterHeader = res.headers.get('Retry-After');
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 2000 * attempt;
      await new Promise(r => setTimeout(r, Number.isFinite(waitMs) ? waitMs : 2000 * attempt));
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('fetchWithRetry: exhausted retries');
}

/** Turns a raw Retry-After header (seconds, per RFC 9110 — Azure always
 * sends the delta-seconds form here, never an HTTP-date) into a human
 * sentence fragment to append to an error message. Empty string if the
 * header is missing or unparseable, so the message degrades gracefully to
 * what it said before this was added. */
function formatRetryAfter(retryAfterHeader: string | null): string {
  const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return ` Try again in about ${seconds} second${seconds === 1 ? '' : 's'}.`;
  const minutes = Math.round(seconds / 60);
  return ` Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

async function getArmToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetchWithRetry(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://management.azure.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || 'Failed to acquire Azure token');
  }
  return data.access_token;
}

async function fetchCostDataWithRetry(url: string, token: string): Promise<Response> {
  return fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'ActualCost',
      timeframe: 'MonthToDate',
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [
          { type: 'Dimension', name: 'ServiceName' },
          { type: 'Dimension', name: 'ResourceGroup' },
        ],
      },
    }),
  });
}

/** The actual live Azure call + transform. Throws on any failure (missing
 * creds, non-OK response, network error) — callers decide what to do with
 * that (see web/lib/db.ts's cost_fetch_requests: this is only ever invoked
 * from the internal route the MCP-server-driven routine calls, never from
 * a page load — see docs/ai-analysis-routine-setup.md). */
export async function fetchLiveCostSpend(sub: { id: string; name: string }, tenantId: string, clientId: string, clientSecret: string, azureSubId: string): Promise<CostPayload> {
  const token = await getArmToken(tenantId, clientId, clientSecret);

  const costRes = await fetchCostDataWithRetry(
    `https://management.azure.com/subscriptions/${azureSubId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
    token
  );

  if (!costRes.ok) {
    const errBody = await costRes.text();
    const message = costRes.status === 429
      ? `Azure Cost Management is rate-limiting this tenant right now — it retried automatically and still failed.${formatRetryAfter(costRes.headers.get('Retry-After'))}`
      : `Cost Management API error: ${errBody.slice(0, 500)}`;
    throw new Error(message);
  }

  const costData = await costRes.json();
  const columns: { name: string }[] = costData.properties?.columns ?? [];
  const rawRows: (string | number)[][] = costData.properties?.rows ?? [];

  const costIdx = columns.findIndex(c => c.name === 'Cost');
  const svcIdx = columns.findIndex(c => c.name === 'ServiceName');
  const rgIdx = columns.findIndex(c => c.name === 'ResourceGroup');
  const currIdx = columns.findIndex(c => c.name === 'Currency');

  const rows: CostRow[] = rawRows.map(r => ({
    cost: Number(r[costIdx]) || 0,
    service: String(r[svcIdx] ?? 'Unknown'),
    resourceGroup: String(r[rgIdx] ?? '(none)') || '(none)',
    currency: String(r[currIdx] ?? 'USD'),
  }));

  // Handles zero-spend accounts gracefully: rows may be empty, or full of
  // $0 entries — both produce valid, empty-looking aggregates, not an error.
  const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
  const currency = rows[0]?.currency ?? 'USD';

  const byServiceMap = new Map<string, number>();
  const byRgMap = new Map<string, number>();
  for (const r of rows) {
    byServiceMap.set(r.service, (byServiceMap.get(r.service) ?? 0) + r.cost);
    byRgMap.set(r.resourceGroup, (byRgMap.get(r.resourceGroup) ?? 0) + r.cost);
  }
  const byService = [...byServiceMap.entries()]
    .map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost);
  const byResourceGroup = [...byRgMap.entries()]
    .map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost);

  return {
    subscription: sub,
    timeframe: 'MonthToDate',
    totalCost: Math.round(totalCost * 100) / 100,
    currency,
    byService,
    byResourceGroup,
    fetchedAt: new Date().toISOString(),
  };
}

/** Resolves a subscription's Azure credentials and performs a live fetch,
 * saving the result into cost_snapshots. Only ever called from the internal
 * route the MCP server's fetch_cost_data tool invokes — never from a page
 * load. Throws on failure; the caller (the internal route) is responsible
 * for recording that against the cost_fetch_requests row. */
export async function refreshCostSnapshot(subscriptionId: string): Promise<CostPayload> {
  const db = await getDB();
  const sub = await getSubscription(subscriptionId);
  if (!sub) throw new Error(`No subscription found with id ${subscriptionId}`);

  const secretRes = await db.query('SELECT client_secret FROM subscriptions WHERE id = $1', [subscriptionId]);
  const row = secretRes.rows[0] as { client_secret: string } | undefined;
  const tenantId = sub.tenant_id || process.env.AZURE_TENANT_ID || '';
  const clientId = sub.client_id || process.env.AZURE_CLIENT_ID || '';
  const clientSecret = (row?.client_secret ? decryptSecret(row.client_secret) : '') || process.env.AZURE_CLIENT_SECRET || '';
  const azureSubId = sub.subscription_id || process.env.AZURE_SUBSCRIPTION_ID || '';

  if (!tenantId || !clientId || !clientSecret || !azureSubId) {
    throw new Error('Missing Azure credentials for this subscription.');
  }

  const payload = await fetchLiveCostSpend({ id: sub.id, name: sub.name }, tenantId, clientId, clientSecret, azureSubId);
  await saveCostSnapshot(subscriptionId, payload);
  return payload;
}

interface MonthCostResult {
  totalCost: number;
  currency: string;
  byService: { name: string; cost: number }[];
}

/** The date bucket's raw value — an integer like 20260701 (first day of the
 * bucket) is the documented shape, but tolerate an ISO string too in case
 * that ever changes — either way, all that's needed out of it is which
 * calendar month the bucket represents. */
function usageDateToYearMonth(raw: string | number): string | null {
  const s = String(raw);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Unlike fetchLiveCostSpend (always 'MonthToDate', granularity 'None'),
 * this asks for 'Monthly' granularity over a wide Custom time period —
 * Azure Cost Management returns one row per (month, service) pair in a
 * SINGLE call, rather than needing one call per month. That's not just an
 * efficiency nicety: this tenant's Cost Management quota is shared and
 * already runs close to its limit (roughly half of recent refreshes have
 * hit 429 over the past week — see git history), so a 6-month backfill
 * doing 6 separate calls was 6x more likely to collide with everything
 * else hitting it. One call is the actual fix, not just more retries.
 * Returns a map keyed by 'YYYY-MM'; a month with zero recorded spend is
 * simply absent from Azure's response, not an error. */
async function fetchCostForMonthRange(tenantId: string, clientId: string, clientSecret: string, azureSubId: string, fromIso: string, toIso: string): Promise<Map<string, MonthCostResult>> {
  const token = await getArmToken(tenantId, clientId, clientSecret);

  const res = await fetchWithRetry(
    `https://management.azure.com/subscriptions/${azureSubId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ActualCost',
        timeframe: 'Custom',
        timePeriod: { from: `${fromIso}T00:00:00+00:00`, to: `${toIso}T23:59:59+00:00` },
        dataset: {
          granularity: 'Monthly',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [{ type: 'Dimension', name: 'ServiceName' }],
        },
      }),
    },
    // A background action nothing is blocking on — worth waiting out a
    // throttle window rather than failing fast like the interactive
    // refresh does. There's only one call now, so more attempts here can't
    // compound into a multi-minute hang the way per-month retries could.
    5
  );

  if (!res.ok) {
    const errBody = await res.text();
    const message = res.status === 429
      ? `Azure Cost Management is rate-limiting this tenant right now.${formatRetryAfter(res.headers.get('Retry-After'))}`
      : `Cost Management API error: ${errBody.slice(0, 300)}`;
    throw new Error(message);
  }

  const data = await res.json();
  const columns: { name: string }[] = data.properties?.columns ?? [];
  const rows: (string | number)[][] = data.properties?.rows ?? [];
  return parseMonthlyCostRows(columns, rows);
}

/** Azure names the date-bucket column after the requested granularity, not
 * a fixed name: 'Monthly' granularity (what this file always requests, see
 * fetchCostForMonthRange) comes back as 'BillingMonth'; 'UsageDate' is only
 * what 'Daily' granularity uses (see external/yomal's cost.go, which
 * requests Daily and does see UsageDate). Checking both keeps this working
 * if Azure's naming for either granularity ever changes. */
export function parseMonthlyCostRows(columns: { name: string }[], rows: (string | number)[][]): Map<string, MonthCostResult> {
  const costIdx = columns.findIndex(c => c.name === 'Cost');
  const svcIdx = columns.findIndex(c => c.name === 'ServiceName');
  const currIdx = columns.findIndex(c => c.name === 'Currency');
  const dateIdx = columns.findIndex(c => c.name === 'BillingMonth' || c.name === 'UsageDate');
  if (dateIdx === -1) {
    throw new Error(`Cost Management response is missing the expected date column (got: ${columns.map(c => c.name).join(', ')})`);
  }

  const byMonth = new Map<string, { total: number; currency: string; services: Map<string, number> }>();
  for (const r of rows) {
    const ym = usageDateToYearMonth(r[dateIdx]);
    if (!ym) continue;
    const cost = Number(r[costIdx]) || 0;
    const svc = String(r[svcIdx] ?? 'Unknown');
    const currency = (currIdx !== -1 && r[currIdx]) ? String(r[currIdx]) : 'USD';

    if (!byMonth.has(ym)) byMonth.set(ym, { total: 0, currency, services: new Map() });
    const entry = byMonth.get(ym)!;
    entry.total += cost;
    entry.services.set(svc, (entry.services.get(svc) ?? 0) + cost);
  }

  const result = new Map<string, MonthCostResult>();
  for (const [ym, entry] of byMonth) {
    const byService = [...entry.services.entries()]
      .map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }))
      .sort((a, b) => b.cost - a.cost);
    result.set(ym, { totalCost: Math.round(entry.total * 100) / 100, currency: entry.currency, byService });
  }
  return result;
}

export interface BackfillResult {
  saved: number;
  skipped: number;
  errors: string[];
}

/** One-time historical fill for cost_snapshot_history using Azure Cost
 * Management's actual past totals — not the live MonthToDate query
 * everything else here uses. Walks backward from last month; the current
 * month is deliberately excluded since it's already tracked live, day by
 * day, and a single lump backfilled value would corrupt that. Fetches the
 * whole requested range in ONE call (see fetchCostForMonthRange) rather
 * than one call per month. Only ever called from the cost-requests route
 * (a user-initiated action) or the internal route a routine calls — never
 * from a page load. */
export async function backfillCostHistory(subscriptionId: string, months: number): Promise<BackfillResult> {
  const db = await getDB();
  const sub = await getSubscription(subscriptionId);
  if (!sub) throw new Error(`No subscription found with id ${subscriptionId}`);

  const secretRes = await db.query('SELECT client_secret FROM subscriptions WHERE id = $1', [subscriptionId]);
  const row = secretRes.rows[0] as { client_secret: string } | undefined;
  const tenantId = sub.tenant_id || process.env.AZURE_TENANT_ID || '';
  const clientId = sub.client_id || process.env.AZURE_CLIENT_ID || '';
  const clientSecret = (row?.client_secret ? decryptSecret(row.client_secret) : '') || process.env.AZURE_CLIENT_SECRET || '';
  const azureSubId = sub.subscription_id || process.env.AZURE_SUBSCRIPTION_ID || '';
  if (!tenantId || !clientId || !clientSecret || !azureSubId) {
    throw new Error('Missing Azure credentials for this subscription.');
  }

  const now = new Date();
  const targets = Array.from({ length: months }, (_, idx) => {
    const target = new Date(now.getFullYear(), now.getMonth() - (idx + 1), 1);
    const year = target.getFullYear();
    const month = target.getMonth() + 1;
    const lastDay = new Date(year, month, 0).getDate();
    return {
      ym: `${year}-${String(month).padStart(2, '0')}`,
      snapshotDate: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  });

  const oldest = targets[targets.length - 1];
  const newest = targets[0];
  const fromIso = `${oldest.ym}-01`;
  const toIso = newest.snapshotDate;

  let byMonth: Map<string, MonthCostResult>;
  try {
    byMonth = await fetchCostForMonthRange(tenantId, clientId, clientSecret, azureSubId, fromIso, toIso);
  } catch (e) {
    throw new Error(`Backfill failed: ${(e as Error).message}`);
  }

  let saved = 0;
  let skipped = 0;
  for (const { ym, snapshotDate } of targets) {
    if (await hasCostSnapshotHistoryRow(subscriptionId, snapshotDate)) {
      skipped++;
      continue;
    }
    // Absent from Azure's response means genuinely zero spend that month,
    // not a fetch failure — the single call above already succeeded.
    const result = byMonth.get(ym) ?? { totalCost: 0, currency: 'USD', byService: [] };
    await saveCostSnapshotHistoryRow(subscriptionId, snapshotDate, result);
    saved++;
  }

  return { saved, skipped, errors: [] };
}
