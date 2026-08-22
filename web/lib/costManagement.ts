import { getDB, getSubscription, saveCostSnapshot } from '@/lib/db';
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
  const db = getDB();
  const sub = getSubscription(subscriptionId);
  if (!sub) throw new Error(`No subscription found with id ${subscriptionId}`);

  const row = db.prepare('SELECT client_secret FROM subscriptions WHERE id = ?').get(subscriptionId) as { client_secret: string } | null;
  const tenantId = sub.tenant_id || process.env.AZURE_TENANT_ID || '';
  const clientId = sub.client_id || process.env.AZURE_CLIENT_ID || '';
  const clientSecret = (row?.client_secret ? decryptSecret(row.client_secret) : '') || process.env.AZURE_CLIENT_SECRET || '';
  const azureSubId = sub.subscription_id || process.env.AZURE_SUBSCRIPTION_ID || '';

  if (!tenantId || !clientId || !clientSecret || !azureSubId) {
    throw new Error('Missing Azure credentials for this subscription.');
  }

  const payload = await fetchLiveCostSpend({ id: sub.id, name: sub.name }, tenantId, clientId, clientSecret, azureSubId);
  saveCostSnapshot(subscriptionId, payload);
  return payload;
}
