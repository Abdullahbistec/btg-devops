import { randomUUID } from 'crypto';
import { getDB } from './core';

// ── Cost Management snapshots + fetch requests ──────────────────────────────────

export interface CostSnapshot {
  subscription_id: string;
  total_cost: number;
  currency: string;
  by_service: { name: string; cost: number }[];        // JSON-encoded { name, cost }[]
  by_resource_group: { name: string; cost: number }[]; // JSON-encoded { name, cost }[]
  fetched_at: string;
}

export async function getCostSnapshot(subscriptionId: string): Promise<CostSnapshot | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM cost_snapshots WHERE subscription_id = $1', [subscriptionId]);
  return rows[0] ?? null;
}

export async function saveCostSnapshot(subscriptionId: string, data: { totalCost: number; currency: string; byService: unknown; byResourceGroup: unknown }): Promise<void> {
  const db = await getDB();
  await db.query(
    `INSERT INTO cost_snapshots (subscription_id, total_cost, currency, by_service, by_resource_group, fetched_at)
     VALUES ($1, $2, $3, $4, $5, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT (subscription_id) DO UPDATE SET
       total_cost = excluded.total_cost,
       currency = excluded.currency,
       by_service = excluded.by_service,
       by_resource_group = excluded.by_resource_group,
       fetched_at = excluded.fetched_at`,
    [subscriptionId, data.totalCost, data.currency, JSON.stringify(data.byService), JSON.stringify(data.byResourceGroup)]
  );

  try {
    await db.query(
      `INSERT INTO cost_snapshot_history (subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)
       VALUES ($1, to_char(now(), 'YYYY-MM-DD'), $2, $3, $4, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
       ON CONFLICT (subscription_id, snapshot_date) DO UPDATE SET
         total_cost = excluded.total_cost,
         currency = excluded.currency,
         by_service = excluded.by_service,
         fetched_at = excluded.fetched_at`,
      [subscriptionId, data.totalCost, data.currency, JSON.stringify(data.byService)]
    );
  } catch (e) {
    console.error('saveCostSnapshot: failed to write cost_snapshot_history (non-fatal):', e);
  }
}

export interface HetznerCostSnapshot {
  id: string;
  total_monthly: number;
  currency: string;
  by_category: Record<string, number>; // JSON-encoded { [category]: number }
  by_type: Record<string, { count: number; monthly_total: number }>;      // JSON-encoded { [serverType]: { count, monthly_total } }
  unpriced: string[];     // JSON-encoded string[] — resources whose price lookup failed
  fetched_at: string;
}

/** `unpriced` (defaulting to an empty list) records resources whose price
 * lookup failed on the Go side (cmd/hetzner_cost.go) and were therefore
 * excluded from totalMonthly. Persisting it — rather than dropping it here —
 * is what lets the API and UI surface a pricing gap instead of it silently
 * becoming an understated $0-inclusive total. */
export interface HetznerCostHistoryPoint {
  day: string;            // YYYY-MM-DD
  total_monthly: number;
  currency: string;
  reconstructed: boolean;
}

/** Whether a MEASURED Hetzner snapshot exists for today (UTC).
 *
 * The daily scheduler guard must ask this rather than "is there any snapshot
 * today". A reconstructed row is derived from creation dates, not observed —
 * if it satisfied the guard, a backfill run before the day's first refresh
 * would make the scheduler skip, and today would stay derived permanently.
 * An observation must always be allowed to replace a replay of one. */
export async function hasMeasuredHetznerSnapshotToday(): Promise<boolean> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT 1 FROM hetzner_cost_snapshots
     WHERE COALESCE(reconstructed, false) = false
       AND (fetched_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
     LIMIT 1`
  );
  return rows.length > 0;
}

/** Writes reconstructed past run-rate points, one row per day.
 *
 * These are DERIVED, not observed: the CLI reconstructs them by replaying
 * resource creation dates against today's list prices, because Hetzner
 * exposes no spend history to fetch. They are flagged `reconstructed` so the
 * chart can draw them distinctly and a reader is never told a derived figure
 * was measured.
 *
 * Two rules this enforces:
 *   - Idempotent. Re-running a backfill must not duplicate days.
 *   - A reconstruction never displaces a real measurement. If a measured row
 *     already exists for a day, the derived one for that day is skipped
 *     entirely — an actual observation always outranks a replay of it.
 */
export async function saveHetznerReconstructedHistory(
  points: { day: string; total_monthly: number; currency: string }[]
): Promise<void> {
  if (points.length === 0) return;
  const db = await getDB();
  for (const p of points) {
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, reconstructed, fetched_at)
       SELECT $1, $2, $3, '{}', '{}', '[]', true, ($4 || 'T12:00:00Z')::timestamptz
       WHERE NOT EXISTS (
         SELECT 1 FROM hetzner_cost_snapshots
         WHERE (fetched_at AT TIME ZONE 'UTC')::date = $4::date
       )`,
      [randomUUID(), p.total_monthly, p.currency, p.day]
    );
  }
}

/** One run-rate point per calendar day, oldest first.
 *
 * Deliberately NOT the same thing as Azure's cost_snapshot_history: that
 * records what was *spent*, this records what the infrastructure *costs per
 * month* as measured on that day. It moves when a server is added or removed,
 * not when something is consumed — so the chart it feeds is labelled a run
 * rate, never spend.
 *
 * Refreshes fire several times a day (the Refresh button plus the scheduler),
 * so the raw table holds many rows per day. DISTINCT ON keeps the last
 * measurement of each day; without it the line shows vertical clusters that
 * read as volatility where there is none. */
export async function getHetznerCostHistory(days: number): Promise<HetznerCostHistoryPoint[]> {
  const db = await getDB();
  const { rows } = await db.query(
    // Bucket by UTC date explicitly, not `fetched_at::date` — that casts in
    // the server's local timezone, so the same rows bucket into different
    // days depending on which machine runs the query, and a late-evening
    // refresh east of UTC lands on tomorrow. Same fix as 68be4ca applied to
    // the Azure cost buckets.
    `SELECT DISTINCT ON ((fetched_at AT TIME ZONE 'UTC')::date)
       to_char((fetched_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
       total_monthly,
       currency,
       COALESCE(reconstructed, false) AS reconstructed
     FROM hetzner_cost_snapshots
     WHERE fetched_at >= now() - ($1 || ' days')::interval
     ORDER BY (fetched_at AT TIME ZONE 'UTC')::date ASC, fetched_at DESC`,
    [days]
  );
  return rows;
}

export async function saveHetznerCostSnapshot(data: { totalMonthly: number; currency: string; byCategory: unknown; byType: unknown; unpriced?: unknown }): Promise<void> {
  const db = await getDB();
  await db.query(
    `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [randomUUID(), data.totalMonthly, data.currency, JSON.stringify(data.byCategory), JSON.stringify(data.byType), JSON.stringify(data.unpriced ?? [])]
  );
}

export async function getHetznerCostSnapshot(): Promise<HetznerCostSnapshot | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM hetzner_cost_snapshots ORDER BY fetched_at DESC LIMIT 1');
  return rows[0] ?? null;
}

export interface CostSnapshotHistoryRow {
  subscription_id: string;
  snapshot_date: string;
  total_cost: number;
  currency: string;
  by_service: { name: string; cost: number }[]; // JSON-encoded { name, cost }[]
  fetched_at: string;
}

export async function getCostSnapshotHistory(subscriptionId: string, days: number): Promise<CostSnapshotHistoryRow[]> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT * FROM cost_snapshot_history
     WHERE subscription_id = $1 AND snapshot_date >= to_char(now() - ($2 || ' days')::interval, 'YYYY-MM-DD')
     ORDER BY snapshot_date ASC`,
    [subscriptionId, days]
  );
  return rows;
}

/** Writes one historical month's actual total directly into
 * cost_snapshot_history, keyed on the last calendar day of that month.
 * Deliberately separate from saveCostSnapshot(): that function also updates
 * cost_snapshots (the CURRENT month's live snapshot) — a backfilled *past*
 * month must never touch that row. Used only by costManagement.ts's
 * backfillCostHistory(). */
export async function saveCostSnapshotHistoryRow(subscriptionId: string, snapshotDate: string, data: { totalCost: number; currency: string; byService: unknown }): Promise<void> {
  const db = await getDB();
  await db.query(
    `INSERT INTO cost_snapshot_history (subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)
     VALUES ($1, $2, $3, $4, $5, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT (subscription_id, snapshot_date) DO UPDATE SET
       total_cost = excluded.total_cost,
       currency = excluded.currency,
       by_service = excluded.by_service,
       fetched_at = excluded.fetched_at`,
    [subscriptionId, snapshotDate, data.totalCost, data.currency, JSON.stringify(data.byService)]
  );
}

export async function hasCostSnapshotHistoryRow(subscriptionId: string, snapshotDate: string): Promise<boolean> {
  const db = await getDB();
  const { rows } = await db.query('SELECT 1 FROM cost_snapshot_history WHERE subscription_id = $1 AND snapshot_date = $2', [subscriptionId, snapshotDate]);
  return rows.length > 0;
}

export interface CostFetchRequest {
  id: string;
  subscription_id: string;
  status: 'pending' | 'done' | 'failed';
  error_message: string;
  requested_at: string;
  completed_at: string | null;
  type: 'refresh' | 'backfill';
  months: number | null;
}

export async function createCostFetchRequest(subscriptionId: string): Promise<CostFetchRequest> {
  const db = await getDB();
  const id = randomUUID();
  await db.query(`INSERT INTO cost_fetch_requests (id, subscription_id) VALUES ($1, $2)`, [id, subscriptionId]);
  return (await getCostFetchRequest(id))!;
}

export async function createCostBackfillRequest(subscriptionId: string, months: number): Promise<CostFetchRequest> {
  const db = await getDB();
  const id = randomUUID();
  await db.query(`INSERT INTO cost_fetch_requests (id, subscription_id, type, months) VALUES ($1, $2, 'backfill', $3)`, [id, subscriptionId, months]);
  return (await getCostFetchRequest(id))!;
}

export async function getCostFetchRequest(id: string): Promise<CostFetchRequest | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM cost_fetch_requests WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** The most recent request for a subscription that's still pending AND
 * genuinely recent, if any — used so the "Refresh" button doesn't queue a
 * duplicate request while one is already in flight for the same
 * subscription. Since /api/cost-requests now processes a request
 * synchronously in the same call that creates it, a 'pending' row should
 * never outlive that one request — if one does (e.g. the process crashed
 * mid-request, or a row was queued before this endpoint processed things
 * synchronously), it's abandoned, not in flight, and must not permanently
 * block every future refresh for that subscription. Two minutes is well
 * beyond refreshCostSnapshot's own retry/backoff ceiling. */
/** In-flight request of the SAME type for this subscription, if any. The
 * type filter matters: a 'refresh' and a 'backfill' do completely different
 * work, so a pending refresh must not make a backfill look already-queued —
 * the caller would return 202 and the backfill would silently never run. */
export async function getPendingCostFetchRequestFor(
  subscriptionId: string,
  type: 'refresh' | 'backfill' = 'refresh'
): Promise<CostFetchRequest | null> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT * FROM cost_fetch_requests
     WHERE subscription_id = $1 AND status = 'pending' AND type = $2
       AND requested_at::timestamp > (now() - interval '2 minutes')
     ORDER BY requested_at DESC LIMIT 1`,
    [subscriptionId, type]
  );
  return rows[0] ?? null;
}

/** True if a backfill was already requested for this subscription today
 * (done, failed, or still pending — any of those means "already tried"),
 * regardless of outcome. Used to throttle the scheduler's self-heal backfill
 * to at most once per calendar day per subscription — without this, a
 * persistent Azure rate-limit failure would retry on every 60s poll cycle
 * instead of waiting for the next day. Compared against plain now() (not a
 * UTC-explicit variant) to match the same basis requested_at's own column
 * default already uses. */
export async function hasBackfillRequestToday(subscriptionId: string): Promise<boolean> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT 1 FROM cost_fetch_requests
     WHERE subscription_id = $1 AND type = 'backfill'
       AND requested_at >= to_char(now(), 'YYYY-MM-DD')
     LIMIT 1`,
    [subscriptionId]
  );
  return rows.length > 0;
}

export async function listPendingCostFetchRequests(): Promise<CostFetchRequest[]> {
  const db = await getDB();
  const { rows } = await db.query(`SELECT * FROM cost_fetch_requests WHERE status = 'pending' ORDER BY requested_at`);
  return rows;
}

/** `note` is for a non-error message worth surfacing on an otherwise
 * successful completion — e.g. a backfill that partially failed but still
 * saved some months. Stored in the same error_message column since there's
 * no dedicated field for it; the status ('done') is what distinguishes it
 * from an actual failure. */
export async function completeCostFetchRequest(id: string, note?: string): Promise<void> {
  const db = await getDB();
  if (note) {
    await db.query(
      `UPDATE cost_fetch_requests SET status = 'done', completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), error_message = $1 WHERE id = $2`,
      [note, id]
    );
  } else {
    await db.query(`UPDATE cost_fetch_requests SET status = 'done', completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`, [id]);
  }
}

export async function failCostFetchRequest(id: string, message: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE cost_fetch_requests SET status = 'failed', error_message = $1, completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [message, id]
  );
}

