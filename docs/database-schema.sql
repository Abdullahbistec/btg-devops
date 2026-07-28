-- btg-devops web app — SQLite schema
-- Source of truth: web/lib/db.ts (initSchema)
-- This file is structure-only — no data, no credentials.

CREATE TABLE subscriptions (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  client_secret   TEXT DEFAULT '',            -- live Azure secret, plaintext — do not expose this table externally
  is_active       INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now')),
  last_audit_at   TEXT
);

CREATE TABLE audits (
  id                 TEXT PRIMARY KEY,
  subscription_id    TEXT NOT NULL REFERENCES subscriptions(id),
  name               TEXT DEFAULT '',
  status             TEXT DEFAULT 'pending',   -- pending | running | completed | failed
  started_at         TEXT,
  completed_at       TEXT,
  total_findings     INTEGER DEFAULT 0,
  critical_count     INTEGER DEFAULT 0,
  warning_count      INTEGER DEFAULT 0,
  info_count         INTEGER DEFAULT 0,
  commands_run       TEXT DEFAULT '[]',        -- JSON array of analyzer command names
  error_message      TEXT DEFAULT '',
  resources_scanned  INTEGER DEFAULT 0
);
CREATE INDEX idx_audits_sub    ON audits(subscription_id);
CREATE INDEX idx_audits_status ON audits(status);

CREATE TABLE findings (
  id                  TEXT PRIMARY KEY,
  audit_id            TEXT NOT NULL REFERENCES audits(id),
  service             TEXT NOT NULL,           -- e.g. "Storage", "PP Apps", "Power BI"
  resource            TEXT DEFAULT '',
  environment         TEXT DEFAULT '',
  severity            TEXT NOT NULL,           -- Critical | Warning | Info
  category            TEXT DEFAULT '',
  description         TEXT DEFAULT '',
  recommendation      TEXT DEFAULT '',
  remediation_status  TEXT DEFAULT 'open',     -- open | acknowledged | resolved | suppressed
  created_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_findings_audit    ON findings(audit_id);
CREATE INDEX idx_findings_severity ON findings(severity);

CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT DEFAULT 'Scheduled Audit',
  frequency       TEXT DEFAULT 'daily',        -- daily | weekly | monthly
  hour            INTEGER DEFAULT 2,
  enabled         INTEGER DEFAULT 1,
  last_run_at     TEXT,
  next_run_at     TEXT,
  subscription_id TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
  -- Note: schedules are stored but not yet executed automatically (no cron/scheduler wired up).
);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  name           TEXT DEFAULT '',
  password_hash  TEXT NOT NULL,               -- scryptSync, salt:hash format
  role           TEXT DEFAULT 'viewer',       -- admin | viewer
  status         TEXT DEFAULT 'pending',      -- pending | active | rejected | inactive
  created_at     TEXT DEFAULT (datetime('now')),
  approved_at    TEXT,
  approved_by    TEXT
);
CREATE INDEX idx_users_email  ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- Relationships: subscriptions (1) -> audits (many) -> findings (many)
-- schedules and users are independent tables, not tied to a specific audit.
