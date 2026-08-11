package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// schema is the full CREATE TABLE IF NOT EXISTS DDL for all 5 tables.
// Safe to run on every startup — idempotent.
const schema = `
CREATE TABLE IF NOT EXISTS users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  TEXT UNIQUE NOT NULL,
  password_hash          TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_login             TIMESTAMPTZ,
  password_reset_token   TEXT,
  password_reset_expires TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  created_by        UUID REFERENCES users(id),
  subscription_id   TEXT NOT NULL,
  subscription_name TEXT,
  trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('manual', 'scheduled')),
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  error_message     TEXT,
  raw_data          JSONB,
  claude_analysis   JSONB,
  resource_counts   JSONB
);

-- cost_data and usage_data are stored as their own columns, not nested
-- inside raw_data, so a query that only needs cost/usage never has to
-- decompress+parse the (much larger) 12-resource-type raw_data blob.
ALTER TABLE audits ADD COLUMN IF NOT EXISTS cost_data  JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS usage_data JSONB;

-- current_step is a lightweight, transient progress indicator for the
-- dashboard's live "Run Audit" view — e.g. "extracting acr (3/12)". Only
-- meaningful while status='running'; cleared once the audit completes/fails
-- so it never shows stale text on a finished audit.
ALTER TABLE audits ADD COLUMN IF NOT EXISTS current_step TEXT;

-- scope_hashes holds one SHA-256 hex digest per resource-type scope (storage,
-- iam, nsg, ...), keyed the same as raw_data's own keys, computed over that
-- scope's cleaned config JSON only — cost_data/usage_data are excluded since
-- they change by nature every audit (rolling cost history, metrics) and
-- would never hit a cache hit. Unchanged hash vs. the previous analyzed audit
-- for the same subscription means that scope's config genuinely didn't
-- change, letting the analyzer skip re-analyzing it (spec 14).
ALTER TABLE audits ADD COLUMN IF NOT EXISTS scope_hashes JSONB;

CREATE TABLE IF NOT EXISTS findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id        UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL CHECK (severity IN ('Critical', 'Warning', 'Info')),
  resource_type   TEXT NOT NULL,
  resource_name   TEXT NOT NULL,
  issue           TEXT NOT NULL,
  recommendation  TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- scope records which Analyze scope produced this row (e.g. "storage",
-- "cost", "usage:storage", "all") — NOT the same as resource_type, which is
-- the LLM's own labeling of the affected resource and isn't reliable enough
-- to detect "these rows came from the same analysis run" on its own. Lets
-- re-analyzing a scope delete-and-replace just that scope's old findings
-- instead of accumulating duplicates on every re-run.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS scope TEXT;

-- Findings lifecycle: status tracks open/resolved/dismissed (validated in
-- the dashboard API, not a DB CHECK, since ALTER..ADD CONSTRAINT isn't
-- idempotent); first_seen_at carries the date an issue was FIRST flagged
-- across successive audits (so a week-old unfixed problem shows "7 days
-- old", not "new" on every audit); resolved_at records when an issue
-- stopped appearing. category is the LLM's classification (Security, Cost
-- Waste, ...) — now persisted since it's part of the cross-audit match key.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS category      TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'open';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS resolved_at   TIMESTAMPTZ;
UPDATE findings SET first_seen_at = created_at WHERE first_seen_at IS NULL;

-- resource_group lets the dashboard group findings the same way the Raw
-- Resource Data view does. Display-only — NOT part of the cross-audit
-- identity key (findingKey in claude.ts), since it's the LLM's own
-- transcription of a value it read off the resource data and could be
-- worded slightly differently between runs. NULL for pre-existing rows and
-- for scopes (cost/usage/all) where a single finding can't cleanly map to
-- one resource group.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS resource_group TEXT;

-- Fields backing the grouped Analysis Results UI (analysis-ui spec):
--
-- child_resource_name: for account-based resource types (Cosmos DB, Storage,
-- App Service Plan), resource_name holds the ACCOUNT/plan name and this
-- holds the specific child (database/container/app) the finding is about.
-- NULL for flat resource types and for account-level findings with no
-- single child.
--
-- affected_resources: for flat resource types, one finding can describe an
-- issue PATTERN shared by many resources (e.g. "admin user enabled" across
-- 12 ACRs) — this array lists every resource name affected, so the UI can
-- render one card with tags instead of one card per resource. Deliberately
-- NOT derived by clustering on issue text after the fact — LLM wording
-- varies run to run (see findingKey's comment in claude.ts), so this is
-- populated directly by the model at analysis time instead.
--
-- cost_impact_usd / cost_impact_note: estimated monthly dollar impact, or a
-- short text label (e.g. "security risk") when no dollar figure applies —
-- the UI must always show one or the other, never leave the slot blank.
--
-- recommendation_steps: the fix as an array of short, numbered steps.
-- Additive alongside the legacy recommendation TEXT column (kept, and
-- still populated as a joined fallback) rather than changing that column's
-- type, so anything still reading recommendation as a plain string
-- (exports, the summary email) keeps working unchanged.
-- DOUBLE PRECISION, not NUMERIC — node-postgres returns NUMERIC columns as
-- strings (to avoid silent precision loss), which would force every reader
-- of this column to remember to parse it. A dollar estimate doesn't need
-- NUMERIC's exact decimal precision, so float8 avoids that footgun and
-- comes back as a plain JS number.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS child_resource_name  TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS affected_resources   TEXT[];
ALTER TABLE findings ADD COLUMN IF NOT EXISTS cost_impact_usd      DOUBLE PRECISION;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS cost_impact_note     TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS recommendation_steps TEXT[];

-- fix_effort (spec 10, Phase 3) — how much work the fix itself costs, kept
-- deliberately separate from severity (how bad the issue is). A finding can
-- be Critical AND quick (flip a toggle) or Warning AND complex (needs a
-- migration) — collapsing the two into one axis is what let "Critical" stop
-- meaning "urgent" in the first place. Lets the UI surface a "quick wins"
-- section: high-severity findings that are also cheap to fix.
-- No CHECK constraint, same reasoning as findings.status above (not
-- idempotent via ALTER..ADD CONSTRAINT) — validated in the dashboard API.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS fix_effort TEXT;

-- finding_type (spec 10 section 5.4) — 'chain' marks a deep-research headline
-- finding (spec 10 section 4 Stage 3): several individually low-severity facts
-- reasoned together into one real attack path, e.g. a public/no-auth
-- resource's managed identity reaching a Key Vault reaching production
-- credentials. Reuses existing columns for the chain's content rather than
-- adding new ones: affected_resources holds every resource in the chain in
-- order, issue holds the full hop-by-hop narrative — 'chain' only flags
-- that THIS finding should render as a distinct headline card at the top of
-- the analysis page instead of blending into the regular findings list.
-- NULL/absent means 'standard' (every finding before this feature, and
-- every non-chain finding after it).
ALTER TABLE findings ADD COLUMN IF NOT EXISTS finding_type TEXT;

-- evidence — the raw field/value proof backing "issue", split out so the UI
-- can render "why this is flagged" as its own section instead of folding it
-- into the plain-English problem sentence. NULL for findings saved before
-- this column existed; the UI simply omits the evidence section for those.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS evidence TEXT;

-- analysis_requests is the queue behind the MCP-server/Claude-Code-orchestrator
-- flow (spec 8): the dashboard writes a pending row instead of calling an LLM
-- API directly, a scheduled Claude Code agent claims it via the MCP server,
-- and writes the result back through the existing updateClaudeAnalysis() /
-- saveFindings() functions unchanged. scope matches findings.scope's values
-- (a resource type, "cost", "usage:<type>", or "all").
CREATE TABLE IF NOT EXISTS analysis_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id      UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error_message TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- cache_hit marks a request whose scope's config hash (audits.scope_hashes)
-- matched the most recent PRIOR audit of the same subscription that has a
-- 'done' request for this same scope (spec 14 — per-scope analysis cache).
-- Set at insert time by whatever created the row (Go auto-queue on collect,
-- or the dashboard's manual Analyze button) — never changed afterward. It is
-- only a marker for the analyzer/UI to act on later (carry-forward findings
-- instead of spending agent time); this column alone does not skip anything.
ALTER TABLE analysis_requests ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id   UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- chat_threads gives each audit multiple separate conversations (like a
-- normal AI chat app). Messages hang off a thread; the LLM only ever sees
-- one thread's history at a time.
CREATE TABLE IF NOT EXISTS chat_threads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id   UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New chat',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES chat_threads(id) ON DELETE CASCADE;

-- Backfill (one-time, idempotent): messages created before threads existed
-- get grouped into one "Conversation 1" thread per audit.
INSERT INTO chat_threads (audit_id, title, created_by, created_at)
SELECT m.audit_id, 'Conversation 1',
       (ARRAY_AGG(m.user_id ORDER BY m.created_at))[1],
       MIN(m.created_at)
FROM chat_messages m
WHERE m.thread_id IS NULL
GROUP BY m.audit_id;

UPDATE chat_messages m
SET thread_id = t.id
FROM (
  SELECT DISTINCT ON (audit_id) id, audit_id
  FROM chat_threads
  ORDER BY audit_id, created_at ASC
) t
WHERE m.thread_id IS NULL AND t.audit_id = m.audit_id;

CREATE TABLE IF NOT EXISTS resources (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  subscription_id   TEXT UNIQUE NOT NULL,
  tenant_id         TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  last_audit_at     TIMESTAMPTZ
);

-- notification_role_settings drives who gets audit-failed alert emails: an
-- admin toggles which roles are "enabled", and the alert is sent to every
-- currently-active user in an enabled role — no per-person list to maintain
-- as users join/leave. Seeding admin=true preserves pre-existing behavior
-- (admins were the only recipients before this table existed) with zero
-- required configuration; ON CONFLICT DO NOTHING keeps the seed idempotent.
CREATE TABLE IF NOT EXISTS notification_role_settings (
  role       TEXT PRIMARY KEY CHECK (role IN ('admin', 'analyst', 'viewer')),
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO notification_role_settings (role, enabled) VALUES
  ('admin', TRUE), ('analyst', FALSE), ('viewer', FALSE)
ON CONFLICT (role) DO NOTHING;

-- data_gap_marks lets an admin/analyst manually record "I applied a fix for
-- this" right after acting on a data_gaps entry (spec: dashboard visibility
-- for data gaps), instead of only finding out whether it worked once the
-- next scheduled audit's analysis runs. One row per (subscription, scope) —
-- re-marking updates it in place rather than creating a history log. The
-- dashboard computes three states from this: no row = "open"; marked_at at
-- or after the latest analysis for that scope = "pending verification" (fix
-- applied, next audit hasn't run yet); marked_at before a LATER analysis
-- that still reports gaps = "reopened" (the fix didn't actually hold).
CREATE TABLE IF NOT EXISTS data_gap_marks (
  subscription_id TEXT NOT NULL,
  scope           TEXT NOT NULL,
  marked_by       UUID REFERENCES users(id),
  marked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note            TEXT,
  PRIMARY KEY (subscription_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_findings_audit_id            ON findings(audit_id);
CREATE INDEX IF NOT EXISTS idx_analysis_requests_status     ON analysis_requests(status);
CREATE INDEX IF NOT EXISTS idx_analysis_requests_audit_id   ON analysis_requests(audit_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_audit_id       ON chat_messages(audit_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash     ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_audits_created_at            ON audits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resources_slug               ON resources(slug);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription_id ON subscriptions(subscription_id);
`

// ApplySchema runs the full schema DDL against the database.
// All CREATE TABLE statements use IF NOT EXISTS — safe to call on every startup.
func ApplySchema(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, schema); err != nil {
		return fmt.Errorf("applying schema: %w", err)
	}
	return nil
}
