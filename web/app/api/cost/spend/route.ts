import { NextResponse } from 'next/server';
import { getDB, getSubscription } from '@/lib/db';

interface CostRow {
  cost: number;
  service: string;
  resourceGroup: string;
  currency: string;
}

async function getArmToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
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

// Real $ spend by service and resource group, via the Azure Cost Management Query
// API. Fetched live on every request — this is deliberately not tied to the audit
// history, so "refresh" always means a fresh call to Azure, not a cached findings set.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const subParam = url.searchParams.get('subscription_id');
    const db = getDB();

    const resolvedSubId = subParam ||
      (db.prepare("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id || '';
    const sub = getSubscription(resolvedSubId);
    if (!sub) {
      return NextResponse.json({ error: 'No active subscription found. Add one in Settings.' }, { status: 404 });
    }

    const row = db.prepare('SELECT client_secret FROM subscriptions WHERE id = ?').get(resolvedSubId) as { client_secret: string } | null;
    const tenantId = sub.tenant_id || process.env.AZURE_TENANT_ID || '';
    const clientId = sub.client_id || process.env.AZURE_CLIENT_ID || '';
    const clientSecret = row?.client_secret || process.env.AZURE_CLIENT_SECRET || '';
    const azureSubId = sub.subscription_id || process.env.AZURE_SUBSCRIPTION_ID || '';

    if (!tenantId || !clientId || !clientSecret || !azureSubId) {
      return NextResponse.json({ error: 'Missing Azure credentials for this subscription.' }, { status: 400 });
    }

    const token = await getArmToken(tenantId, clientId, clientSecret);

    const costRes = await fetch(
      `https://management.azure.com/subscriptions/${azureSubId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
      {
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
      }
    );

    if (!costRes.ok) {
      const errBody = await costRes.text();
      return NextResponse.json({ error: `Cost Management API error: ${errBody.slice(0, 500)}` }, { status: costRes.status });
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

    return NextResponse.json({
      subscription: { id: sub.id, name: sub.name },
      timeframe: 'MonthToDate',
      totalCost: Math.round(totalCost * 100) / 100,
      currency,
      byService,
      byResourceGroup,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
