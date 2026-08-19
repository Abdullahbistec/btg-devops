import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

let _db: DatabaseSync | null = null;

export function getDB(): DatabaseSync {
  if (!_db) {
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'btg-devops.db');
    _db = new DatabaseSync(dbPath);
    _db.exec("PRAGMA journal_mode = WAL");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_audit_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      total_findings INTEGER DEFAULT 0,
      critical_count INTEGER DEFAULT 0,
      warning_count INTEGER DEFAULT 0,
      info_count INTEGER DEFAULT 0,
      commands_run TEXT DEFAULT '[]',
      error_message TEXT DEFAULT '',
      resources_scanned INTEGER DEFAULT 0,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      service TEXT NOT NULL,
      resource TEXT DEFAULT '',
      environment TEXT DEFAULT '',
      severity TEXT NOT NULL,
      category TEXT DEFAULT '',
      description TEXT DEFAULT '',
      recommendation TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (audit_id) REFERENCES audits(id)
    );

    CREATE INDEX IF NOT EXISTS idx_findings_audit ON findings(audit_id);
    CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
    CREATE INDEX IF NOT EXISTS idx_audits_sub ON audits(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT DEFAULT 'Scheduled Audit',
      frequency TEXT DEFAULT 'daily',
      hour INTEGER DEFAULT 2,
      enabled INTEGER DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      subscription_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      name         TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      role         TEXT DEFAULT 'viewer',
      status       TEXT DEFAULT 'pending',
      created_at   TEXT DEFAULT (datetime('now')),
      approved_at  TEXT,
      approved_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

    -- Async AI-analysis requests, picked up by a scheduled Claude Code
    -- routine polling through the MCP server (cmd/mcp.go --http) instead of
    -- a synchronous, metered LLM call. See docs/ai-analysis-routine-setup.md.
    CREATE TABLE IF NOT EXISTS analysis_requests (
      id            TEXT PRIMARY KEY,
      audit_id      TEXT NOT NULL,
      scope         TEXT DEFAULT 'all',
      status        TEXT DEFAULT 'pending',
      summary       TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      requested_at  TEXT DEFAULT (datetime('now')),
      completed_at  TEXT,
      FOREIGN KEY (audit_id) REFERENCES audits(id)
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
      total_cost        REAL DEFAULT 0,
      currency          TEXT DEFAULT 'USD',
      by_service        TEXT DEFAULT '[]',
      by_resource_group TEXT DEFAULT '[]',
      fetched_at        TEXT DEFAULT (datetime('now'))
    );

    -- Queue of "please refresh cost_snapshots for this subscription"
    -- requests, picked up by the same scheduled Claude Code routine that
    -- services analysis_requests. See docs/ai-analysis-routine-setup.md.
    CREATE TABLE IF NOT EXISTS cost_fetch_requests (
      id             TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      error_message  TEXT DEFAULT '',
      requested_at   TEXT DEFAULT (datetime('now')),
      completed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cost_fetch_requests_status ON cost_fetch_requests(status);
  `);

  // Migrations
  try { db.exec(`ALTER TABLE findings ADD COLUMN remediation_status TEXT DEFAULT 'open'`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN resources_scanned INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN owner TEXT DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN current_step TEXT DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN total_steps INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN completed_steps INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN location TEXT DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN monthly_cost REAL DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN monthly_saving REAL DEFAULT NULL`); } catch {}

  // Seed default subscription from env vars if table is empty
  const row = db.prepare('SELECT COUNT(*) as c FROM subscriptions').get() as unknown as { c: number };
  if (row.c === 0) {
    db.prepare(`
      INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, client_secret)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      'Bistec Global Production',
      process.env.AZURE_SUBSCRIPTION_ID || '',
      process.env.AZURE_TENANT_ID || '',
      process.env.AZURE_CLIENT_ID || '',
      process.env.AZURE_CLIENT_SECRET || ''
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
}

export function listSubscriptions(): Subscription[] {
  return getDB().prepare(`
    SELECT id, name, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at
    FROM subscriptions ORDER BY created_at DESC
  `).all() as unknown as Subscription[];
}

/** Minimal, non-sensitive subscription list (id/name/active only) — safe for
 * viewer-level read access, unlike listSubscriptions() which is admin-only. */
export function listSubscriptionsBasic(): { id: string; name: string; is_active: number }[] {
  return getDB().prepare(`
    SELECT id, name, is_active FROM subscriptions ORDER BY created_at DESC
  `).all() as unknown as { id: string; name: string; is_active: number }[];
}

export function getSubscription(id: string): Subscription | null {
  return (getDB().prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) ?? null) as unknown as Subscription | null;
}

export function createSubscription(data: Omit<Subscription, 'id' | 'created_at' | 'last_audit_at' | 'is_active'>): Subscription {
  const id = uuidv4();
  getDB().prepare(`
    INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.name, data.subscription_id, data.tenant_id, data.client_id);
  return getSubscription(id)!;
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

export function listAudits(subscriptionId?: string): Audit[] {
  const db = getDB();
  if (subscriptionId) {
    return db.prepare('SELECT * FROM audits WHERE subscription_id = ? ORDER BY started_at DESC').all(subscriptionId) as unknown as Audit[];
  }
  return db.prepare('SELECT * FROM audits ORDER BY started_at DESC').all() as unknown as Audit[];
}

export function getAudit(id: string): Audit | null {
  return (getDB().prepare('SELECT * FROM audits WHERE id = ?').get(id) ?? null) as unknown as Audit | null;
}

export function createAudit(subscriptionId: string, name: string, plannedCommands: string[] = []): Audit {
  const id = uuidv4();
  getDB().prepare(`
    INSERT INTO audits (id, subscription_id, name, status, started_at, total_steps, commands_run)
    VALUES (?, ?, ?, 'running', datetime('now'), ?, ?)
  `).run(id, subscriptionId, name, plannedCommands.length, JSON.stringify(plannedCommands));
  return getAudit(id)!;
}

/** Called as each analyzer command starts, so the UI can show real progress
 * instead of a simulated timer. */
export function updateAuditStep(id: string, currentStep: string, completedSteps: number) {
  getDB().prepare(`UPDATE audits SET current_step = ?, completed_steps = ? WHERE id = ?`).run(currentStep, completedSteps, id);
}

export function updateAuditCounts(id: string, critical: number, warning: number, info: number, commands: string[], resourcesScanned = 0) {
  getDB().prepare(`
    UPDATE audits SET
      total_findings = ?,
      critical_count = ?,
      warning_count = ?,
      info_count = ?,
      commands_run = ?,
      resources_scanned = ?,
      status = 'completed',
      completed_at = datetime('now')
    WHERE id = ?
  `).run(critical + warning + info, critical, warning, info, JSON.stringify(commands), resourcesScanned, id);

  const audit = getAudit(id);
  if (audit) {
    getDB().prepare(`UPDATE subscriptions SET last_audit_at = datetime('now') WHERE id = ?`).run(audit.subscription_id);
  }
}

export function failAudit(id: string, message: string) {
  getDB().prepare(`
    UPDATE audits SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?
  `).run(message, id);
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

export function insertFindings(auditId: string, findings: Omit<Finding, 'id' | 'audit_id' | 'created_at'>[]) {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO findings (id, audit_id, service, resource, environment, severity, category, description, recommendation, owner, location, monthly_cost, monthly_saving)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const f of findings) {
      stmt.run(uuidv4(), auditId, f.service, f.resource, f.environment, f.severity, f.category, f.description, f.recommendation, f.owner || '', f.location || '', f.monthly_cost ?? null, f.monthly_saving ?? null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function listFindings(auditId?: string, severity?: string): Finding[] {
  const db = getDB();
  if (auditId && severity) {
    return db.prepare('SELECT * FROM findings WHERE audit_id = ? AND severity = ? ORDER BY severity, service').all(auditId, severity) as unknown as Finding[];
  }
  if (auditId) {
    return db.prepare('SELECT * FROM findings WHERE audit_id = ? ORDER BY severity, service').all(auditId) as unknown as Finding[];
  }
  return db.prepare('SELECT * FROM findings ORDER BY created_at DESC, severity').all() as unknown as Finding[];
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

export function getUserByEmail(email: string): User | null {
  return (getDB().prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as unknown as User) ?? null;
}

export function createUser(id: string, email: string, name: string, passwordHash: string): void {
  getDB().prepare(
    `INSERT INTO users (id, email, name, password_hash, role, status) VALUES (?, ?, ?, ?, 'viewer', 'pending')`
  ).run(id, email.toLowerCase(), name, passwordHash);
}

export function listUsers(status?: string): User[] {
  if (status) return getDB().prepare('SELECT * FROM users WHERE status = ? ORDER BY created_at DESC').all(status) as unknown as User[];
  return getDB().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as unknown as User[];
}

export function updateUserStatus(id: string, status: string, approvedBy: string): void {
  getDB().prepare(
    `UPDATE users SET status = ?, approved_at = datetime('now'), approved_by = ? WHERE id = ?`
  ).run(status, approvedBy, id);
}

export function deleteUser(id: string): void {
  getDB().prepare('DELETE FROM users WHERE id = ?').run(id);
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

export function createAnalysisRequest(auditId: string, scope: string): AnalysisRequest {
  const id = uuidv4();
  getDB().prepare(`
    INSERT INTO analysis_requests (id, audit_id, scope) VALUES (?, ?, ?)
  `).run(id, auditId, scope);
  return getAnalysisRequest(id)!;
}

export function getAnalysisRequest(id: string): AnalysisRequest | null {
  return (getDB().prepare('SELECT * FROM analysis_requests WHERE id = ?').get(id) ?? null) as unknown as AnalysisRequest | null;
}

export function listPendingAnalysisRequests(): AnalysisRequest[] {
  return getDB().prepare(`SELECT * FROM analysis_requests WHERE status = 'pending' ORDER BY requested_at`).all() as unknown as AnalysisRequest[];
}

export function completeAnalysisRequest(id: string, summary: string): void {
  getDB().prepare(`
    UPDATE analysis_requests SET status = 'done', summary = ?, completed_at = datetime('now') WHERE id = ?
  `).run(summary, id);
}

export function failAnalysisRequest(id: string, message: string): void {
  getDB().prepare(`
    UPDATE analysis_requests SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?
  `).run(message, id);
}

// ── Cost Management snapshots + fetch requests (async, via MCP + routine) ──────

export interface CostSnapshot {
  subscription_id: string;
  total_cost: number;
  currency: string;
  by_service: string;        // JSON-encoded { name, cost }[]
  by_resource_group: string; // JSON-encoded { name, cost }[]
  fetched_at: string;
}

export function getCostSnapshot(subscriptionId: string): CostSnapshot | null {
  return (getDB().prepare('SELECT * FROM cost_snapshots WHERE subscription_id = ?').get(subscriptionId) ?? null) as unknown as CostSnapshot | null;
}

export function saveCostSnapshot(subscriptionId: string, data: { totalCost: number; currency: string; byService: unknown; byResourceGroup: unknown }): void {
  getDB().prepare(`
    INSERT INTO cost_snapshots (subscription_id, total_cost, currency, by_service, by_resource_group, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(subscription_id) DO UPDATE SET
      total_cost = excluded.total_cost,
      currency = excluded.currency,
      by_service = excluded.by_service,
      by_resource_group = excluded.by_resource_group,
      fetched_at = excluded.fetched_at
  `).run(subscriptionId, data.totalCost, data.currency, JSON.stringify(data.byService), JSON.stringify(data.byResourceGroup));
}

export interface CostFetchRequest {
  id: string;
  subscription_id: string;
  status: 'pending' | 'done' | 'failed';
  error_message: string;
  requested_at: string;
  completed_at: string | null;
}

export function createCostFetchRequest(subscriptionId: string): CostFetchRequest {
  const id = uuidv4();
  getDB().prepare(`INSERT INTO cost_fetch_requests (id, subscription_id) VALUES (?, ?)`).run(id, subscriptionId);
  return getCostFetchRequest(id)!;
}

export function getCostFetchRequest(id: string): CostFetchRequest | null {
  return (getDB().prepare('SELECT * FROM cost_fetch_requests WHERE id = ?').get(id) ?? null) as unknown as CostFetchRequest | null;
}

/** The most recent request for a subscription that's still pending, if any —
 * used so the "Refresh" button doesn't queue a duplicate request while one
 * is already in flight for the same subscription. */
export function getPendingCostFetchRequestFor(subscriptionId: string): CostFetchRequest | null {
  return (getDB().prepare(
    `SELECT * FROM cost_fetch_requests WHERE subscription_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`
  ).get(subscriptionId) ?? null) as unknown as CostFetchRequest | null;
}

export function listPendingCostFetchRequests(): CostFetchRequest[] {
  return getDB().prepare(`SELECT * FROM cost_fetch_requests WHERE status = 'pending' ORDER BY requested_at`).all() as unknown as CostFetchRequest[];
}

export function completeCostFetchRequest(id: string): void {
  getDB().prepare(`UPDATE cost_fetch_requests SET status = 'done', completed_at = datetime('now') WHERE id = ?`).run(id);
}

export function failCostFetchRequest(id: string, message: string): void {
  getDB().prepare(`UPDATE cost_fetch_requests SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`).run(message, id);
}

// ── Dashboard aggregates ───────────────────────────────────────────────────────

export function getDashboardStats(auditId?: string) {
  const db = getDB();

  const auditFilter = auditId ? `WHERE audit_id = '${auditId.replace(/'/g, '')}'` : '';

  const byService = db.prepare(`
    SELECT service, COUNT(*) as count
    FROM findings ${auditFilter}
    GROUP BY service
    ORDER BY count DESC
  `).all() as unknown as { service: string; count: number }[];

  const bySeverity = db.prepare(`
    SELECT severity, COUNT(*) as count
    FROM findings ${auditFilter}
    GROUP BY severity
  `).all() as unknown as { severity: string; count: number }[];

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM findings ${auditFilter}
    GROUP BY category
    ORDER BY count DESC
  `).all() as unknown as { category: string; count: number }[];

  const recentAudits = db.prepare(`
    SELECT id, name, status, started_at, total_findings, critical_count, warning_count, info_count
    FROM audits
    ORDER BY started_at DESC
    LIMIT 10
  `).all() as unknown as Audit[];

  return { byService, bySeverity, byCategory, recentAudits };
}
