import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { encryptSecret } from './crypto';

let _pool: Pool | null = null;
let _ready: Promise<void> | null = null;

/** Returns a ready connection pool — schema applied and (on a fresh
 * database) the default subscription seeded, exactly once, before this
 * ever resolves for any caller. Every exported function below awaits this
 * first, mirroring how the old SQLite getDB() guaranteed a ready database
 * synchronously; the difference here is unavoidable since applying schema
 * over a real connection is inherently a network round-trip, not a local
 * file open. */
export async function getDB(): Promise<Pool> {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — see web/.env.local');
    }
    _pool = new Pool({ connectionString });
    _ready = initSchema(_pool);
  }
  await _ready;
  return _pool;
}

async function initSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      client_id       TEXT NOT NULL,
      client_secret   TEXT DEFAULT '',
      is_active       INTEGER DEFAULT 1,
      created_at      TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      last_audit_at   TEXT,
      monthly_budget  DOUBLE PRECISION DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS audits (
      id                TEXT PRIMARY KEY,
      subscription_id   TEXT NOT NULL REFERENCES subscriptions(id),
      name              TEXT DEFAULT '',
      status            TEXT DEFAULT 'pending',
      started_at        TEXT,
      completed_at      TEXT,
      total_findings    INTEGER DEFAULT 0,
      critical_count    INTEGER DEFAULT 0,
      warning_count     INTEGER DEFAULT 0,
      info_count        INTEGER DEFAULT 0,
      commands_run      TEXT DEFAULT '[]',
      error_message     TEXT DEFAULT '',
      resources_scanned INTEGER DEFAULT 0,
      current_step      TEXT DEFAULT '',
      total_steps       INTEGER DEFAULT 0,
      completed_steps   INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS findings (
      id                 TEXT PRIMARY KEY,
      audit_id           TEXT NOT NULL REFERENCES audits(id),
      service            TEXT NOT NULL,
      resource           TEXT DEFAULT '',
      environment        TEXT DEFAULT '',
      severity           TEXT NOT NULL,
      category           TEXT DEFAULT '',
      description        TEXT DEFAULT '',
      recommendation     TEXT DEFAULT '',
      created_at         TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      remediation_status TEXT DEFAULT 'open',
      owner              TEXT DEFAULT '',
      location           TEXT DEFAULT '',
      monthly_cost       DOUBLE PRECISION DEFAULT NULL,
      monthly_saving     DOUBLE PRECISION DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_findings_audit    ON findings(audit_id);
    CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
    CREATE INDEX IF NOT EXISTS idx_audits_sub        ON audits(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_audits_status     ON audits(status);

    CREATE TABLE IF NOT EXISTS schedules (
      id              TEXT PRIMARY KEY,
      name            TEXT DEFAULT 'Scheduled Audit',
      frequency       TEXT DEFAULT 'daily',
      hour            INTEGER DEFAULT 2,
      enabled         INTEGER DEFAULT 1,
      last_run_at     TEXT,
      next_run_at     TEXT,
      subscription_id TEXT,
      created_at      TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      role          TEXT DEFAULT 'viewer',
      status        TEXT DEFAULT 'pending',
      created_at    TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      approved_at   TEXT,
      approved_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

    -- Async AI-analysis requests, picked up by a scheduled Claude Code
    -- routine polling through the MCP server (cmd/mcp.go --http) instead of
    -- a synchronous, metered LLM call. See docs/ai-analysis-routine-setup.md.
    CREATE TABLE IF NOT EXISTS analysis_requests (
      id            TEXT PRIMARY KEY,
      audit_id      TEXT NOT NULL REFERENCES audits(id),
      scope         TEXT DEFAULT 'all',
      status        TEXT DEFAULT 'pending',
      summary       TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      requested_at  TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      completed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_requests_status ON analysis_requests(status);

    -- Last-known-good Cost Management data per subscription. The dashboard's
    -- /api/cost/spend reads ONLY this table — it never calls Azure live from
    -- a page load. A row here is only ever written by the same MCP +
    -- Claude-routine mechanism as analysis_requests, via cost_fetch_requests
    -- below, since Cost Management's rate limit is tight enough that
    -- calling it from the request path caused recurring user-visible 429s.
    CREATE TABLE IF NOT EXISTS cost_snapshots (
      subscription_id   TEXT PRIMARY KEY,
      total_cost        DOUBLE PRECISION DEFAULT 0,
      currency          TEXT DEFAULT 'USD',
      by_service        TEXT DEFAULT '[]',
      by_resource_group TEXT DEFAULT '[]',
      fetched_at        TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    -- Queue of "please refresh cost_snapshots for this subscription"
    -- requests. In this single-tenant deployment /api/cost-requests
    -- processes a request synchronously in the same call that creates it —
    -- this table exists for observability and as a hook for a future
    -- MCP-routine-driven multi-tenant deployment, not because anything
    -- drains it externally today.
    CREATE TABLE IF NOT EXISTS cost_fetch_requests (
      id              TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      status          TEXT DEFAULT 'pending',
      error_message   TEXT DEFAULT '',
      requested_at    TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      completed_at    TEXT,
      type            TEXT DEFAULT 'refresh',
      months          INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_fetch_requests_status ON cost_fetch_requests(status);

    -- Append-only daily history behind cost_snapshots — that table only
    -- ever holds the latest value (ON CONFLICT DO UPDATE on
    -- subscription_id), so a trend chart has nothing to read. This table
    -- is written alongside it, from the same saveCostSnapshot() call, so
    -- there is exactly one place a snapshot is ever produced. One row per
    -- subscription per calendar day — a second same-day refresh updates
    -- that day's row rather than inserting a duplicate.
    -- IMPORTANT: total_cost here is Azure's MonthToDate cumulative spend as
    -- of that snapshot_date, not a per-day delta — it rises through the
    -- month and resets near zero at the start of each calendar month.
    CREATE TABLE IF NOT EXISTS cost_snapshot_history (
      subscription_id TEXT NOT NULL,
      snapshot_date   TEXT NOT NULL,
      total_cost      DOUBLE PRECISION NOT NULL,
      currency        TEXT NOT NULL,
      by_service      TEXT NOT NULL,
      fetched_at      TEXT NOT NULL,
      PRIMARY KEY (subscription_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_cost_snapshot_history_sub ON cost_snapshot_history(subscription_id, snapshot_date);
  `);

  // Seed default subscription from env vars if the table is empty — same
  // condition the old SQLite path used.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM subscriptions');
  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, client_secret)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        uuidv4(),
        'Bistec Global Production',
        process.env.AZURE_SUBSCRIPTION_ID || '',
        process.env.AZURE_TENANT_ID || '',
        process.env.AZURE_CLIENT_ID || '',
        process.env.AZURE_CLIENT_SECRET || '',
      ]
    );
  }
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export interface Subscription {
  id: string;
  name: string;
  subscription_id: string;
  tenant_id: string;
  client_id: string;
  is_active: number;
  created_at: string;
  last_audit_at: string | null;
  monthly_budget: number | null;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const db = await getDB();
  const { rows } = await db.query(`
    SELECT id, name, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at, monthly_budget
    FROM subscriptions ORDER BY created_at DESC
  `);
  return rows;
}

/** Minimal, non-sensitive subscription list (id/name/active only) — safe for
 * viewer-level read access, unlike listSubscriptions() which is admin-only. */
export async function listSubscriptionsBasic(): Promise<{ id: string; name: string; is_active: number }[]> {
  const db = await getDB();
  const { rows } = await db.query(`SELECT id, name, is_active FROM subscriptions ORDER BY created_at DESC`);
  return rows;
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT id, name, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at, monthly_budget
     FROM subscriptions WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** Nullable — a subscription with no budget set simply hides budget-dependent
 * UI (Cost page tiles, reference lines) rather than falling back to a made-up
 * number. */
export async function updateSubscriptionBudget(id: string, monthlyBudget: number | null): Promise<void> {
  const db = await getDB();
  await db.query(`UPDATE subscriptions SET monthly_budget = $1 WHERE id = $2`, [monthlyBudget, id]);
}

export async function createSubscription(
  data: Omit<Subscription, 'id' | 'created_at' | 'last_audit_at' | 'is_active' | 'monthly_budget'> & { client_secret?: string }
): Promise<Subscription> {
  const db = await getDB();
  const id = uuidv4();
  await db.query(
    `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, client_secret)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, data.name, data.subscription_id, data.tenant_id, data.client_id, data.client_secret ? encryptSecret(data.client_secret) : '']
  );
  return (await getSubscription(id))!;
}

// ── Audits ────────────────────────────────────────────────────────────────────

export interface Audit {
  id: string;
  subscription_id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: string | null;
  completed_at: string | null;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  commands_run: string;
  error_message: string;
  current_step?: string;
  total_steps?: number;
  completed_steps?: number;
}

export async function listAudits(subscriptionId?: string): Promise<Audit[]> {
  const db = await getDB();
  if (subscriptionId) {
    const { rows } = await db.query('SELECT * FROM audits WHERE subscription_id = $1 ORDER BY started_at DESC', [subscriptionId]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM audits ORDER BY started_at DESC');
  return rows;
}

export async function getAudit(id: string): Promise<Audit | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM audits WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function createAudit(subscriptionId: string, name: string, plannedCommands: string[] = []): Promise<Audit> {
  const db = await getDB();
  const id = uuidv4();
  await db.query(
    `INSERT INTO audits (id, subscription_id, name, status, started_at, total_steps, commands_run)
     VALUES ($1, $2, $3, 'running', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), $4, $5)`,
    [id, subscriptionId, name, plannedCommands.length, JSON.stringify(plannedCommands)]
  );
  return (await getAudit(id))!;
}

/** Called as each analyzer command starts, so the UI can show real progress
 * instead of a simulated timer. */
export async function updateAuditStep(id: string, currentStep: string, completedSteps: number): Promise<void> {
  const db = await getDB();
  await db.query(`UPDATE audits SET current_step = $1, completed_steps = $2 WHERE id = $3`, [currentStep, completedSteps, id]);
}

export async function updateAuditCounts(id: string, critical: number, warning: number, info: number, commands: string[], resourcesScanned = 0): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE audits SET
       total_findings = $1,
       critical_count = $2,
       warning_count = $3,
       info_count = $4,
       commands_run = $5,
       resources_scanned = $6,
       status = 'completed',
       completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = $7`,
    [critical + warning + info, critical, warning, info, JSON.stringify(commands), resourcesScanned, id]
  );

  const audit = await getAudit(id);
  if (audit) {
    await db.query(`UPDATE subscriptions SET last_audit_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`, [audit.subscription_id]);
  }
}

export async function failAudit(id: string, message: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE audits SET status = 'failed', error_message = $1, completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [message, id]
  );
}

// ── Findings ──────────────────────────────────────────────────────────────────

export interface Finding {
  id: string;
  audit_id: string;
  service: string;
  resource: string;
  environment: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  owner: string;
  location: string;
  monthly_cost: number | null;
  monthly_saving: number | null;
  created_at: string;
}

export async function insertFindings(auditId: string, findings: Omit<Finding, 'id' | 'audit_id' | 'created_at'>[]): Promise<void> {
  const db = await getDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const f of findings) {
      await client.query(
        `INSERT INTO findings (id, audit_id, service, resource, environment, severity, category, description, recommendation, owner, location, monthly_cost, monthly_saving)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [uuidv4(), auditId, f.service, f.resource, f.environment, f.severity, f.category, f.description, f.recommendation, f.owner || '', f.location || '', f.monthly_cost ?? null, f.monthly_saving ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listFindings(auditId?: string, severity?: string): Promise<Finding[]> {
  const db = await getDB();
  if (auditId && severity) {
    const { rows } = await db.query('SELECT * FROM findings WHERE audit_id = $1 AND severity = $2 ORDER BY severity, service', [auditId, severity]);
    return rows;
  }
  if (auditId) {
    const { rows } = await db.query('SELECT * FROM findings WHERE audit_id = $1 ORDER BY severity, service', [auditId]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM findings ORDER BY created_at DESC, severity');
  return rows;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] ?? null;
}

export async function createUser(id: string, email: string, name: string, passwordHash: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `INSERT INTO users (id, email, name, password_hash, role, status) VALUES ($1, $2, $3, $4, 'viewer', 'pending')`,
    [id, email.toLowerCase(), name, passwordHash]
  );
}

export async function listUsers(status?: string): Promise<User[]> {
  const db = await getDB();
  if (status) {
    const { rows } = await db.query('SELECT * FROM users WHERE status = $1 ORDER BY created_at DESC', [status]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM users ORDER BY created_at DESC');
  return rows;
}

export async function updateUserStatus(id: string, status: string, approvedBy: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE users SET status = $1, approved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), approved_by = $2 WHERE id = $3`,
    [status, approvedBy, id]
  );
}

export async function deleteUser(id: string): Promise<void> {
  const db = await getDB();
  await db.query('DELETE FROM users WHERE id = $1', [id]);
}

// ── Analysis requests (async AI analysis via the MCP + Claude Code routine) ────

export interface AnalysisRequest {
  id: string;
  audit_id: string;
  scope: string;
  status: 'pending' | 'done' | 'failed';
  summary: string;
  error_message: string;
  requested_at: string;
  completed_at: string | null;
}

export async function createAnalysisRequest(auditId: string, scope: string): Promise<AnalysisRequest> {
  const db = await getDB();
  const id = uuidv4();
  await db.query(`INSERT INTO analysis_requests (id, audit_id, scope) VALUES ($1, $2, $3)`, [id, auditId, scope]);
  return (await getAnalysisRequest(id))!;
}

export async function getAnalysisRequest(id: string): Promise<AnalysisRequest | null> {
  const db = await getDB();
  const { rows } = await db.query('SELECT * FROM analysis_requests WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function listPendingAnalysisRequests(): Promise<AnalysisRequest[]> {
  const db = await getDB();
  const { rows } = await db.query(`SELECT * FROM analysis_requests WHERE status = 'pending' ORDER BY requested_at`);
  return rows;
}

export async function completeAnalysisRequest(id: string, summary: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE analysis_requests SET status = 'done', summary = $1, completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [summary, id]
  );
}

export async function failAnalysisRequest(id: string, message: string): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE analysis_requests SET status = 'failed', error_message = $1, completed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [message, id]
  );
}

// ── Cost Management snapshots + fetch requests ──────────────────────────────────

export interface CostSnapshot {
  subscription_id: string;
  total_cost: number;
  currency: string;
  by_service: string;        // JSON-encoded { name, cost }[]
  by_resource_group: string; // JSON-encoded { name, cost }[]
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

export interface CostSnapshotHistoryRow {
  subscription_id: string;
  snapshot_date: string;
  total_cost: number;
  currency: string;
  by_service: string; // JSON-encoded { name, cost }[]
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
  const id = uuidv4();
  await db.query(`INSERT INTO cost_fetch_requests (id, subscription_id) VALUES ($1, $2)`, [id, subscriptionId]);
  return (await getCostFetchRequest(id))!;
}

export async function createCostBackfillRequest(subscriptionId: string, months: number): Promise<CostFetchRequest> {
  const db = await getDB();
  const id = uuidv4();
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
export async function getPendingCostFetchRequestFor(subscriptionId: string): Promise<CostFetchRequest | null> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT * FROM cost_fetch_requests
     WHERE subscription_id = $1 AND status = 'pending'
       AND requested_at::timestamp > (now() - interval '2 minutes')
     ORDER BY requested_at DESC LIMIT 1`,
    [subscriptionId]
  );
  return rows[0] ?? null;
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

// ── Dashboard aggregates ───────────────────────────────────────────────────────

export async function getDashboardStats(auditId?: string) {
  const db = await getDB();
  const filterClause = auditId ? 'WHERE audit_id = $1' : '';
  const params = auditId ? [auditId] : [];

  const [byService, bySeverity, byCategory, recentAudits] = await Promise.all([
    db.query(`SELECT service, COUNT(*)::int as count FROM findings ${filterClause} GROUP BY service ORDER BY count DESC`, params),
    db.query(`SELECT severity, COUNT(*)::int as count FROM findings ${filterClause} GROUP BY severity`, params),
    db.query(`SELECT category, COUNT(*)::int as count FROM findings ${filterClause} GROUP BY category ORDER BY count DESC`, params),
    db.query(`SELECT id, name, status, started_at, total_findings, critical_count, warning_count, info_count
              FROM audits ORDER BY started_at DESC LIMIT 10`),
  ]);

  return {
    byService: byService.rows,
    bySeverity: bySeverity.rows,
    byCategory: byCategory.rows,
    recentAudits: recentAudits.rows,
  };
}
