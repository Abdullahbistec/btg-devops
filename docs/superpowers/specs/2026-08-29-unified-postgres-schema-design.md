# Unified Postgres Schema — Design

Date: 2026-08-29
Branch: abd-production-2

## Context

`btg-devops` currently exists as two codebases that share the exact same Go
module path (`github.com/chanbistec/btg-devops`) but were built and are
deployed separately: this repo's root `cmd/` (14 Azure + 5 Power Platform +
5 Hetzner analyzers, writing nothing itself — a stateless CLI whose JSON
output the Next.js dashboard in `web/` persists into a local SQLite file,
`web/btg-devops.db`), and `external/yomal/CLI Engine` (21 Azure extractors,
its own ported copy of the 4 core Power Platform extractors, and a real
`collect` command that writes directly to a Postgres/Supabase database —
paired with its own, now-retiring Next.js dashboard).

A live comparison run this session, querying both real databases directly,
found a concrete reason to stop treating these as permanently separate:
the async AI-analysis queue (`analysis_requests`, serviced by an MCP server
+ scheduled Claude Code routine — identical mechanism on both sides) has
never once completed a request on the main product's SQLite side (0 of 8,
oldest 18 days old) but holds a 493-of-494 completion rate on Yomal's
Postgres side, including real substantive Claude-written findings on a
Power Platform audit this session built and verified live. The mechanism
isn't broken — the main product's side of it has simply never been
exercised successfully, and there's no reason to keep building two parallel,
unequally-reliable copies of the same thing.

Decision, confirmed this session: merge into one product, one Postgres
database, `web/`'s dashboard as the sole surviving frontend (Yomal's
dashboard retires), SQLite removed. This spec covers only the first step —
**the schema and the ability to connect to it** — not the analyzer merge,
not the write-path change, not the dashboard cutover, and not deleting
anything. Those are later, separately-planned steps; see the roadmap below.

## Roadmap (for context — only Sub-project 1 is designed here)

| # | Sub-project | Delivers | Status |
|---|---|---|---|
| 1 | **Schema unification** | Migration SQL, Go pgx pool | **this spec** |
| 2 | Analyzer reconciliation | One merged Go analyzer set (resolves ~13 filename collisions, folds in Yomal's `vm`/`cdn`/`cost`/usage extractors) | not started |
| 3 | Collector write-path | `cmd/` gains direct-Postgres-write behavior (adapts Yomal's existing `cmd/collect.go`) | not started |
| 4 | `web/` cutover | Repoint ~16 SQLite call-sites at Postgres, same API contracts | not started |
| 5 | MCP consolidation | Down to one MCP server (`cmd/mcp.go`); Yomal's Next.js MCP route retires with its dashboard | not started |
| 6 | Retire SQLite + Yomal's dashboard | Remove `node:sqlite`, delete `web/lib/db.ts`'s SQLite code, archive `external/yomal/dashboard` | not started |

SQLite keeps working exactly as it does today throughout Sub-projects 1-3 —
nothing in this spec touches `web/lib/db.ts` or removes anything. Sub-project
4 is the actual cutover; Sub-project 6 is the actual removal.

## Goals

- One Postgres schema, reachable from Go, that Sub-project 2's merged
  analyzers and Sub-project 4's dashboard cutover can both build on without
  a second schema migration.
- Base it on Yomal's existing schema (already the more complete, already
  proven under the real load documented above), extended with the pieces
  only `web/`'s SQLite schema has today.
- `findings` and `audits` — the two tables with genuine structural
  differences between the two sides — get an explicit, reviewed column
  mapping (below), not just table-name matching.
- Migration is additive/idempotent (`CREATE TABLE IF NOT EXISTS`, matching
  the convention both existing schemas already use), safe to run against
  Yomal's live Supabase database without touching its existing rows.

## Non-goals

- **Not removing SQLite.** `web/lib/db.ts` is untouched by this spec.
  Nothing reads or writes the new schema yet outside of this spec's own
  verification step.
- **Not merging Go analyzer code.** The ~13 filename collisions between
  `cmd/` and Yomal's `CLI Engine`, and folding in Yomal's exclusive `vm`/
  `cdn`/`cost`/usage extractors, are Sub-project 2.
  **Whichever Go code eventually writes to this schema is a
  schema-change-not-specified-here concern per the session's own guardrail
  ("if a stage requires a schema change I didn't specify, stop and ask") —
  Sub-project 2 must come back to this spec's table if it needs a column
  this one doesn't have, not add one silently.**
- **Not cutting `web/` over to read/write Postgres.** Sub-project 4.
- **Not retiring Yomal's dashboard or its dashboard-only tables' data** —
  those tables are simply not part of the unified schema going forward;
  Yomal's existing Postgres database and its `chat_messages`/`user_sessions`/
  etc. rows are untouched by this migration (it runs against the *same*
  database, additively — dropping tables is a separate, deliberate decision
  for Sub-project 6, not a side effect of this one).

## Full table list

**Kept from Yomal, column-reconciled (see mappings below):** `subscriptions`,
`audits`, `findings`, `analysis_requests`.

**Kept from Yomal as-is:** `resources` — a small resource-type catalog
(slug → name/description) used as Claude-analysis context; real usage
confirmed in `external/yomal/dashboard/app/api/controllers/audit.ts`, kept
since it supports the same optional raw-data/Claude-analysis capability
`audits`'s JSONB columns carry forward.

**Kept from `web/` as-is:** `users` (`web/`'s dashboard survives; its own
approval-workflow auth schema — `status`/`approved_by` — is what's
actually in use, not Yomal's differently-shaped, now-retiring one),
`schedules`, `cost_snapshots`, `cost_fetch_requests`, `cost_snapshot_history`
(Yomal has no cost-tracking family at all).

**Not part of the unified schema** (Yomal-dashboard-specific; not created
by this migration, existing rows on Yomal's database untouched):
`user_sessions`, `chat_messages`, `chat_threads`,
`notification_role_settings`, `data_gap_marks`.

## Column mapping — `findings`

| Unified column | Origin | Notes |
|---|---|---|
| `id`, `audit_id`, `severity`, `category`, `recommendation`, `created_at` | both (identical) | |
| `resource_type` | Yomal | `web/`'s Go write path maps its `service` value here |
| `resource_name` | Yomal | `web/`'s Go write path maps its `resource` value here |
| `environment` | `web/` | Yomal has no equivalent concept; needed for Power Platform findings |
| `issue` | Yomal | `web/`'s Go write path maps its `description` value here |
| `status`, `first_seen_at`, `resolved_at`, `resource_group`, `child_resource_name`, `affected_resources` (text[]), `cost_impact_usd`, `cost_impact_note`, `recommendation_steps` (text[]), `fix_effort`, `finding_type`, `evidence`, `scope` | Yomal | Available, not mandatory — `web/`'s findings can leave these null and keep working |
| `location`, `monthly_cost`, `monthly_saving` | `web/` (Aug 19 work) | The Aug 19 sub-project only touched `web/`'s SQLite schema — confirmed absent from Yomal's real Postgres `findings` table via direct query. Must be added by this migration, not assumed present. |

## Column mapping — `audits`

| Unified column | Origin | Notes |
|---|---|---|
| `id`, `subscription_id`, `status`, `error_message`, `created_at` | both (identical or trivially compatible) | |
| `raw_data`, `claude_analysis`, `cost_data`, `usage_data`, `scope_hashes`, `current_step` (jsonb) | Yomal | Available-but-optional; `web/`'s Go-written audits don't need to populate these |
| `total_findings`, `critical_count`, `warning_count`, `info_count`, `resources_scanned`, `commands_run` | `web/` | Real columns, not derived from JSONB — kept so `web/`'s existing dashboard queries need no read-path rewrite when Sub-project 4 arrives |
| `trigger_type` (manual/scheduled) | Yomal | Net-new capability for `web/`'s side; optional to populate |
| `subscription_name` | Yomal | Denormalized convenience field |

## Migration SQL

Appended as a new, additive migration against Yomal's existing Postgres
database — every statement is `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, matching the idempotent
convention both `web/lib/db.ts` and Yomal's `internal/db/schema.go`
already use. Existing rows in `audits`, `findings`, `analysis_requests`,
`subscriptions`, `resources` are untouched; new columns default to `NULL`
or a sensible default so old rows remain valid.

```sql
-- findings: add web/'s columns Yomal doesn't have. Verified via direct
-- query against the live database that none of these four exist yet —
-- the Aug 19 location/cost-fields sub-project only touched web/'s SQLite
-- schema, not Yomal's Postgres.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS environment     TEXT DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS location        TEXT DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS monthly_cost    REAL DEFAULT NULL;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS monthly_saving  REAL DEFAULT NULL;

-- audits: add web/'s explicit count columns
ALTER TABLE audits ADD COLUMN IF NOT EXISTS total_findings    INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS critical_count    INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS warning_count     INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS info_count        INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS resources_scanned INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS commands_run      JSONB DEFAULT '[]';

-- subscriptions, analysis_requests, resources: already fully compatible,
-- no schema change needed (subscriptions already has the `type` column
-- from the Aug 17 Power Platform sub-project; analysis_requests already
-- has `cache_hit`; a `summary` column is added for web/'s use):
ALTER TABLE analysis_requests ADD COLUMN IF NOT EXISTS summary TEXT DEFAULT '';
```

`users`, `schedules`, `cost_snapshots`, `cost_fetch_requests`,
`cost_snapshot_history` are net-new `CREATE TABLE IF NOT EXISTS` additions
to this database, copied verbatim from `web/lib/db.ts`'s existing SQLite
DDL (Postgres-compatible as written — `TEXT`/`INTEGER`/`REAL` all map
directly; `datetime('now')` becomes `now()`).

## Go connectivity

New file `internal/db/postgres.go` (this repo's root, not Yomal's — this is
where Sub-project 2's merged analyzers will eventually live): a `pgxpool.Pool`
constructor reading its DSN from `BTG_POSTGRES_DSN`, mirroring the
connection pattern already proven in Yomal's `CLI Engine/internal/db/db.go`.
Exposed but not called from anywhere yet — this spec ships connectivity,
not usage.

## Testing

- Run the migration SQL against Yomal's real Supabase database (already
  have working credentials — `external/yomal/dashboard/.env.local`) inside
  a transaction, verify it applies cleanly, verify existing row counts in
  `audits`/`findings`/`analysis_requests`/`subscriptions` are unchanged
  before/after.
- Go: a test that opens the pool via `BTG_POSTGRES_DSN`, runs one real
  query (e.g. `SELECT count(*) FROM subscriptions`), confirms a non-error
  connection — proving connectivity works, not exercising any write path
  (there isn't one yet).
- Manual verification: after the migration, directly query the new/altered
  columns (`SELECT environment, location, monthly_cost FROM findings LIMIT 1`,
  `SELECT total_findings, commands_run FROM audits LIMIT 1`) to confirm they
  exist with the right types and defaults.

## Risks

| Risk | Mitigation |
|---|---|
| Running this migration against Yomal's *live, real* Supabase database (not a staging copy) | Every statement is additive (`ADD COLUMN IF NOT EXISTS`); no `DROP`, no `ALTER ... TYPE`, no data modification. Row-count check before/after in testing catches any unintended side effect immediately. |
| Sub-project 2 discovers it needs a column this schema doesn't have | Explicit guardrail in Non-goals: that comes back to this spec's table for a deliberate addition, not a silent `ALTER TABLE` buried in a later PR. |
| `findings.environment` default `''` vs Yomal's existing rows having no concept of environment at all | Matches the existing pattern already used for every other Yomal→`web/` gap column in this migration — old rows simply read back an empty string, exactly as `web/`'s own SQLite schema already defaults it. |
