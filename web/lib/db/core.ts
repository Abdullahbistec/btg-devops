import { Pool, types } from 'pg';
import { randomUUID } from 'crypto';
import { runMigrations } from '../migrations';

// Timestamp columns are stored as timestamptz (migration 0004), but the whole
// codebase reads them as the canonical UTC 'YYYY-MM-DD HH24:MI:SS' string (see
// lib/schedule-time.ts's invariant). Every connection runs in UTC (the pool's
// `options` below), so Postgres renders timestamptz with a +00 offset — taking
// the first 19 chars yields exactly that UTC wall-clock string, so the ~95
// call sites that consumed the old TEXT columns keep working unchanged.
//
// Registered lazily from inside getDB() (which only ever runs in the Node.js
// server), NOT at module top level: a top-level side effect here forces pg's
// node-only internals into the Edge bundle that instrumentation.ts pulls in,
// which fails the build with "Can't resolve 'crypto'". pg.types is a global
// singleton, so registering once is enough and safe.
const toUtcString = (v: string | null) => (v ? v.slice(0, 19).replace('T', ' ') : v);
let _tsParsersRegistered = false;
function registerTimestampParsers() {
  if (_tsParsersRegistered) return;
  types.setTypeParser(1114, toUtcString); // timestamp without time zone
  types.setTypeParser(1184, toUtcString); // timestamp with time zone
  _tsParsersRegistered = true;
}

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
    registerTimestampParsers();
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — see web/.env.local');
    }
    // options '-c timezone=UTC' fixes the session timezone at connection
    // startup (before any query runs — race-free), so timestamptz values are
    // read and written in UTC regardless of the host's own zone. Critical on a
    // +05:30 host, exactly the offset lib/schedule-time.ts documents being
    // bitten by.
    const pool = new Pool({ connectionString, options: '-c timezone=UTC' });
    // pg emits 'error' on *idle* clients — a Postgres restart or a dropped
    // connection, not anything a caller awaited. With no listener that is an
    // unhandled EventEmitter error, which takes the whole Next.js process
    // down; the pool itself discards the bad client and keeps working, so
    // logging is the correct response rather than rethrowing.
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err);
    });
    _pool = pool;
    // Cache the readiness promise, but drop it *and* the pool if applying
    // schema fails — otherwise one transient failure (the app booting before
    // Postgres accepts connections) poisons every later getDB() call for the
    // lifetime of the process. Resetting lets the next caller retry.
    // Baseline schema first (idempotent), then versioned migrations for
    // changes a re-runnable baseline can't express (see lib/migrations.ts).
    _ready = initSchema(pool)
      .then(() => runMigrations(pool))
      .then(() => undefined)
      .catch((err) => {
        _pool = null;
        _ready = null;
        void pool.end().catch(() => {});
        throw err;
      });
  }
  const pool = _pool;
  await _ready;
  return pool;
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
      monthly_saving     DOUBLE PRECISION DEFAULT NULL,
      support_ticket_ref TEXT DEFAULT ''
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
      times_per_day   INTEGER DEFAULT 1,
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

    -- One live OTP per email; a resend replaces the previous row rather than
    -- adding another. Holds a SHA-256 of the code, never the code itself —
    -- an OTP is a credential, and this table is readable by anything with a
    -- database connection. attempts lives here rather than in process
    -- memory so the 3-strike lockout is global: a single atomic
    -- UPDATE ... RETURNING claims an attempt, so two concurrent guesses (or
    -- two app instances) cannot both observe attempts < MAX and slip past.
    CREATE TABLE IF NOT EXISTS otp_codes (
      email      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    );

    -- Fixed-window rate-limit counters. bucket encodes what is being
    -- limited and for whom, e.g. 'login:ip:203.0.113.4'. window_start is
    -- the epoch floored to the window size, so a row is one counter for one
    -- window and the whole check is a single atomic upsert -- no read-then-
    -- write race, and it holds across instances, which an in-process Map
    -- would not.
    CREATE TABLE IF NOT EXISTS rate_limit_hits (
      bucket       TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_hits(window_start);

    -- Append-only trail of privileged actions. actor is the verified
    -- session identity, or '' when the action somehow ran without one --
    -- which is itself worth recording rather than dropping. detail is
    -- JSON-encoded context, deliberately free-form because each action
    -- carries different fields and this table is read by people, not
    -- joined on.
    CREATE TABLE IF NOT EXISTS audit_log (
      id         TEXT PRIMARY KEY,
      actor      TEXT NOT NULL DEFAULT '',
      action     TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '{}',
      ip         TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON audit_log(actor);

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

    -- Latest Hetzner cost estimate, mirroring cost_snapshots' shape for
    -- Azure — one row is written per fetch and getHetznerCostSnapshot()
    -- always reads back the newest by fetched_at, since (unlike
    -- cost_snapshots) there is no natural single-row key to upsert on.
    CREATE TABLE IF NOT EXISTS hetzner_cost_snapshots (
      id            TEXT PRIMARY KEY,
      total_monthly DOUBLE PRECISION NOT NULL,
      currency      TEXT NOT NULL,
      by_category   TEXT NOT NULL,
      by_type       TEXT NOT NULL,
      unpriced      TEXT DEFAULT '[]',
      fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Idempotent column migrations. Every CREATE TABLE above is IF NOT EXISTS,
  // so it is a no-op against a database that already has the table — which
  // means a column added to the DDL after that database was first created
  // never actually appears, and queries fail with "column does not exist".
  // The SQLite original carried this same list as try/catch'd ALTERs;
  // Postgres supports IF NOT EXISTS natively, so nothing is swallowed here.
  // Any column added to an existing table from now on belongs in BOTH the
  // DDL above (for fresh databases) and this list (for existing ones).
  // Anything a re-runnable baseline CANNOT express — a column type change,
  // a data backfill, a rename or drop — goes in lib/migrations.ts as an
  // ordered, once-applied migration instead, not here.
  await pool.query(`
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS remediation_status TEXT DEFAULT 'open';
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS owner              TEXT DEFAULT '';
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS location           TEXT DEFAULT '';
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS monthly_cost       DOUBLE PRECISION DEFAULT NULL;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS monthly_saving     DOUBLE PRECISION DEFAULT NULL;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS support_ticket_ref TEXT DEFAULT '';
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS confidence         DOUBLE PRECISION DEFAULT NULL;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS reasoning          TEXT DEFAULT NULL;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS currency           TEXT DEFAULT NULL;

    ALTER TABLE audits ADD COLUMN IF NOT EXISTS resources_scanned INTEGER DEFAULT 0;
    ALTER TABLE audits ADD COLUMN IF NOT EXISTS current_step      TEXT DEFAULT '';
    ALTER TABLE audits ADD COLUMN IF NOT EXISTS total_steps       INTEGER DEFAULT 0;
    ALTER TABLE audits ADD COLUMN IF NOT EXISTS completed_steps   INTEGER DEFAULT 0;

    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS monthly_budget DOUBLE PRECISION DEFAULT NULL;

    ALTER TABLE cost_fetch_requests ADD COLUMN IF NOT EXISTS type   TEXT DEFAULT 'refresh';
    ALTER TABLE cost_fetch_requests ADD COLUMN IF NOT EXISTS months INTEGER DEFAULT NULL;

    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS times_per_day INTEGER DEFAULT 1;

    ALTER TABLE hetzner_cost_snapshots ADD COLUMN IF NOT EXISTS unpriced TEXT DEFAULT '[]';
    ALTER TABLE hetzner_cost_snapshots ADD COLUMN IF NOT EXISTS reconstructed BOOLEAN DEFAULT false;
  `);

  // Seed default subscription from env vars if the table is empty — same
  // condition the old SQLite path used.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM subscriptions');
  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, client_secret)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        'Bistec Global Production',
        process.env.AZURE_SUBSCRIPTION_ID || '',
        process.env.AZURE_TENANT_ID || '',
        process.env.AZURE_CLIENT_ID || '',
        process.env.AZURE_CLIENT_SECRET || '',
      ]
    );
  }
}

