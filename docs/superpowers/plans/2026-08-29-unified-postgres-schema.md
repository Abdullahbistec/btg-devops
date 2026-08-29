# Unified Postgres Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `btg-devops` one Postgres schema — Yomal's existing, already-proven Supabase database, extended with the columns/tables only `web/`'s SQLite schema has today — reachable from Go, so later sub-projects (analyzer reconciliation, collector write-path, `web/` cutover) have a single target to build against instead of two divergent schemas.

**Architecture:** Extend Yomal's existing idempotent schema file (`internal/db/schema.go`, applied via `pool.Exec` on every startup — safe to re-run) with additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements for tables that already exist with real data (`findings`, `audits`, `analysis_requests`, `users`), and `CREATE TABLE IF NOT EXISTS` statements for tables that are genuinely new (`schedules`, `cost_snapshots`, `cost_fetch_requests`, `cost_snapshot_history`). Separately, give the main repo (`cmd/`'s codebase) its own Postgres connection helper so it can reach this database in later sub-projects, without yet writing to it.

**Tech Stack:** Go 1.25.5, `github.com/jackc/pgx/v5` v5.10.0 (pinned to match Yomal's `CLI Engine/go.mod` exactly), Postgres (Supabase-hosted).

**Spec:** `docs/superpowers/specs/2026-08-29-unified-postgres-schema-design.md`

## Global Constraints

- `github.com/jackc/pgx/v5` must be pinned to **v5.10.0** — the exact version already in use in `external/yomal/CLI Engine/go.mod`. Do not let `go get` pull a newer minor/patch.
- Every migration statement is `ADD COLUMN IF NOT EXISTS` or `CREATE TABLE IF NOT EXISTS`. No `DROP`, no `ALTER ... TYPE`, no `UPDATE`/`DELETE` against existing rows. This runs against Yomal's **live, real** Supabase database — not a staging copy.
- `web/lib/db.ts` (the SQLite code) is not touched anywhere in this plan. Nothing in this plan reads or writes SQLite.
- `users`, `schedules`, `cost_snapshots`, `cost_fetch_requests`, `cost_snapshot_history`, `findings`, `audits`, `analysis_requests` are the only tables this plan touches. Do not add, rename, or drop any other table or column — if a later sub-project needs one, it goes back to the spec first (see spec's Non-goals).
- The Supabase connection string lives in `external/yomal/dashboard/.env.local` as `DATABASE_URL` (or `POSTGRES_URL` — check both, whichever is set). Treat it as a secret: never print it, never commit it, never put it in a log line.

---

### Task 1: Reconcile existing tables — `findings`, `audits`, `analysis_requests`, `users`

**Files:**
- Modify: `external/yomal/CLI Engine/internal/db/schema.go`

**Interfaces:**
- Consumes: nothing new — this task only appends to the existing `schema` string constant and relies on the existing `ApplySchema(ctx, pool)` function (schema.go:318-323) to run it.
- Produces: seven altered tables' new columns, available to any code that queries them from here on (Task 3's Go pool, and later sub-projects).

- [ ] **Step 1: Add the reconciliation ALTER statements**

Open `external/yomal/CLI Engine/internal/db/schema.go`. Find the line:

```go
CREATE INDEX IF NOT EXISTS idx_findings_audit_id            ON findings(audit_id);
```

(currently line 306, immediately after the Power Platform `subscriptions` ALTER block). Insert the following block **immediately before** that `CREATE INDEX` section, so it lands after the last existing ALTER and before the indexes:

```go
-- Unified-schema sub-project 1 (2026-08-29): pull in the columns web/'s
-- SQLite schema has that this table doesn't, so web/'s existing
-- dashboard queries need no read-path rewrite when a later sub-project
-- cuts web/ over to this database. Verified via direct query against
-- this live database that none of these columns existed before this
-- migration — see docs/superpowers/specs/2026-08-29-unified-postgres-schema-design.md.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS environment        TEXT DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS location           TEXT DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS monthly_cost       DOUBLE PRECISION DEFAULT NULL;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS monthly_saving     DOUBLE PRECISION DEFAULT NULL;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS remediation_status TEXT DEFAULT 'open';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS owner              TEXT DEFAULT '';

ALTER TABLE audits ADD COLUMN IF NOT EXISTS total_findings    INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS critical_count    INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS warning_count     INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS info_count        INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS resources_scanned INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS commands_run      JSONB DEFAULT '[]';
ALTER TABLE audits ADD COLUMN IF NOT EXISTS total_steps       INTEGER DEFAULT 0;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS completed_steps   INTEGER DEFAULT 0;

ALTER TABLE analysis_requests ADD COLUMN IF NOT EXISTS summary TEXT DEFAULT '';

-- public.users already exists on this database with 3 real rows in
-- Yomal's shape (id/email/password_hash/role/is_active/...) — this is
-- NOT a net-new table. Add web/'s approval-workflow columns to the
-- existing table; a CREATE TABLE IF NOT EXISTS here would silently
-- no-op and never add them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS name         TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'approved';
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by  TEXT DEFAULT NULL;

```

**Note on `users.status` default:** web/'s SQLite default is `'pending'` (new signups need approval). Yomal's 3 existing users are real, already-active accounts — defaulting their *new* `status` column to `'pending'` would make them look unapproved. Use `'approved'` as the column default here so backfilling existing rows is correct; `web/`'s own application code (Sub-project 4) is what sets `'pending'` at *insert* time for new signups, not the column default.

- [ ] **Step 2: Verify the file still builds**

Run: `cd "external/yomal/CLI Engine" && go build ./...`
Expected: exits 0, no output.

- [ ] **Step 3: Apply and verify against the live database, inside a transaction**

First, save the exact SQL statements from Step 1 (just the SQL — not the Go comment lines) to a local file named `reconcile-1.sql` in the current directory.

From `external/yomal/dashboard` (where `.env.local` lives), run:

```bash
node -e "
const fs = require('fs');
const env = {};
fs.readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([^=#]+)=(.*)\$/);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^['\"]|['\"]\$/g,'');
});
const sql = fs.readFileSync('reconcile-1.sql', 'utf8');
const { Client } = require('pg');
const c = new Client({ connectionString: env.DATABASE_URL || env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(async () => {
  const before = await c.query('SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM findings) f, (SELECT count(*) FROM audits) a');
  console.log('before:', before.rows[0]);
  await c.query('BEGIN');
  await c.query(sql);
  const cols = await c.query(\"SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('findings','audits','users') AND column_name IN ('environment','location','monthly_cost','monthly_saving','remediation_status','owner','total_steps','completed_steps','name','status','approved_at','approved_by') ORDER BY table_name, column_name\");
  console.log('new columns:', cols.rows);
  await c.query('COMMIT');
  const after = await c.query('SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM findings) f, (SELECT count(*) FROM audits) a');
  console.log('after: ', after.rows[0]);
  await c.end();
}).catch(async e => { console.error('ERR', e.message); try { await c.query('ROLLBACK'); } catch {}; process.exit(1); });
"
```

Expected: `before` and `after` row counts for `u`/`f`/`a` are **identical** (this is additive-only — no rows added or removed), and `new columns` lists all 12 columns across the three tables, all inside one transaction that only commits if every statement succeeded.

- [ ] **Step 4: Commit**

```bash
git add "external/yomal/CLI Engine/internal/db/schema.go"
git commit -m "feat(db): reconcile findings/audits/analysis_requests/users columns for unified schema"
```

---

### Task 2: Add net-new tables — `schedules`, `cost_snapshots`, `cost_fetch_requests`, `cost_snapshot_history`

**Files:**
- Modify: `external/yomal/CLI Engine/internal/db/schema.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: four new tables, available to any code that queries them from here on.

- [ ] **Step 1: Add the CREATE TABLE statements**

Immediately after the block added in Task 1 (still before the `CREATE INDEX IF NOT EXISTS idx_findings_audit_id` line), add:

```go
-- Net-new tables from web/'s SQLite schema — verified via direct,
-- schema-scoped query against this live database that none of these
-- four exist yet (unlike users, findings, and audits above, which
-- looked net-new but weren't).
CREATE TABLE IF NOT EXISTS schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT DEFAULT 'Scheduled Audit',
  frequency       TEXT DEFAULT 'daily',
  hour            INTEGER DEFAULT 2,
  enabled         BOOLEAN DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  subscription_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cost_snapshots (
  subscription_id   TEXT PRIMARY KEY,
  total_cost        DOUBLE PRECISION DEFAULT 0,
  currency          TEXT DEFAULT 'USD',
  by_service        JSONB DEFAULT '[]',
  by_resource_group JSONB DEFAULT '[]',
  fetched_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cost_fetch_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',
  error_message   TEXT DEFAULT '',
  requested_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cost_fetch_requests_status ON cost_fetch_requests(status);

CREATE TABLE IF NOT EXISTS cost_snapshot_history (
  subscription_id TEXT NOT NULL,
  snapshot_date   DATE NOT NULL,
  total_cost      DOUBLE PRECISION NOT NULL,
  currency        TEXT NOT NULL,
  by_service      JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subscription_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cost_snapshot_history_sub ON cost_snapshot_history(subscription_id, snapshot_date);

```

Note the type changes from `web/`'s literal SQLite DDL, deliberate not accidental:
- `id TEXT PRIMARY KEY` → `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` (matches every other table in this schema — `web/`'s Go write path in a later sub-project generates or receives a UUID either way).
- `INTEGER` used as a boolean (`enabled INTEGER DEFAULT 1`) → `BOOLEAN DEFAULT TRUE` (matches `subscriptions.is_active`, `analysis_requests.cache_hit` elsewhere in this same file).
- `TEXT DEFAULT '[]'` (JSON-as-text) → `JSONB DEFAULT '[]'` for `by_service`/`by_resource_group` (matches `audits.raw_data` etc. elsewhere in this file — Postgres has real JSON, no reason to store it as opaque text here).
- `snapshot_date TEXT` → `snapshot_date DATE` (Postgres has a real date type; `web/`'s SQLite has no such type and stores an ISO date string instead).
- `total_cost REAL` → `total_cost DOUBLE PRECISION` (SQLite's `REAL` is 8-byte/double-precision; Postgres's `REAL` is 4-byte/single-precision — `DOUBLE PRECISION` is the type that actually matches, not a same-named coincidence).

- [ ] **Step 2: Verify the file still builds**

Run: `cd "external/yomal/CLI Engine" && go build ./...`
Expected: exits 0, no output.

- [ ] **Step 3: Apply and verify against the live database, inside a transaction**

Save the exact SQL statements from Step 1 (just the SQL — not the Go comment lines) to a local file named `net-new-2.sql` in the current directory.

From `external/yomal/dashboard`, run:

```bash
node -e "
const fs = require('fs');
const env = {};
fs.readFileSync('.env.local','utf8').split('\n').forEach(l => {
  const m = l.match(/^([^=#]+)=(.*)\$/);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^['\"]|['\"]\$/g,'');
});
const sql = fs.readFileSync('net-new-2.sql', 'utf8');
const { Client } = require('pg');
const c = new Client({ connectionString: env.DATABASE_URL || env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(async () => {
  await c.query('BEGIN');
  await c.query(sql);
  const tables = await c.query(\"SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('schedules','cost_snapshots','cost_fetch_requests','cost_snapshot_history')\");
  console.log('new tables:', tables.rows);
  await c.query('COMMIT');
  await c.end();
}).catch(async e => { console.error('ERR', e.message); try { await c.query('ROLLBACK'); } catch {}; process.exit(1); });
"
```

Expected: `new tables` lists all four table names, committed inside one transaction.

- [ ] **Step 4: Commit**

```bash
git add "external/yomal/CLI Engine/internal/db/schema.go"
git commit -m "feat(db): add schedules/cost_snapshots/cost_fetch_requests/cost_snapshot_history tables"
```

---

### Task 3: Go Postgres connectivity for the main repo

**Files:**
- Create: `internal/db/postgres.go`
- Test: `internal/db/postgres_test.go`
- Modify: `go.mod`, `go.sum` (via `go get`/`go mod tidy`)

**Interfaces:**
- Consumes: `BTG_POSTGRES_DSN` environment variable (a Postgres connection string).
- Produces: `db.Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error)` in package `db` (import path `github.com/chanbistec/btg-devops/internal/db`) — later sub-projects (analyzer reconciliation, collector write-path) call this to get a pool. Signature and behavior deliberately mirror Yomal's own `internal/db/db.go:Connect`.

- [ ] **Step 1: Add the pgx dependency, pinned**

Run:
```bash
go get github.com/jackc/pgx/v5@v5.10.0
go mod tidy
```

Verify `go.mod` now has `github.com/jackc/pgx/v5 v5.10.0` under the top `require` block — check the exact version string, not just presence.

- [ ] **Step 2: Write the failing test**

Create `internal/db/postgres_test.go`:

```go
package db

import (
	"context"
	"os"
	"testing"
)

// TestConnect_LiveDatabase is an integration test against a real Postgres
// instance. Skipped unless BTG_POSTGRES_DSN is set, matching the pattern
// other live-credential tests in this repo use (see cmd/hetzner_test.go).
func TestConnect_LiveDatabase(t *testing.T) {
	dsn := os.Getenv("BTG_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("BTG_POSTGRES_DSN not set; skipping live Postgres connectivity test")
	}

	ctx := context.Background()
	pool, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer pool.Close()

	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM subscriptions").Scan(&count); err != nil {
		t.Fatalf("querying subscriptions: %v", err)
	}
	if count < 0 {
		t.Fatalf("impossible negative count: %d", count)
	}
}

func TestConnect_InvalidDSN(t *testing.T) {
	ctx := context.Background()
	_, err := Connect(ctx, "postgres://invalid:invalid@localhost:1/nonexistent")
	if err == nil {
		t.Fatal("expected an error connecting to an invalid DSN, got nil")
	}
}
```

- [ ] **Step 3: Run it to confirm it fails (package doesn't exist yet)**

Run: `go test ./internal/db/... -run TestConnect -v`
Expected: FAIL — `package db is not in std` / `Connect` undefined (the `internal/db` package doesn't exist yet).

- [ ] **Step 4: Implement `Connect`**

Create `internal/db/postgres.go`:

```go
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect creates a connection pool to the unified Postgres database
// (the same Supabase-hosted database Yomal's CLI Engine already writes
// to — see docs/superpowers/specs/2026-08-29-unified-postgres-schema-design.md).
// databaseURL must be a valid Postgres connection string, typically from
// the BTG_POSTGRES_DSN environment variable. Mirrors the connection
// pattern in external/yomal/CLI Engine/internal/db/db.go:Connect.
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connecting to database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}
	return pool, nil
}
```

- [ ] **Step 5: Run the test again**

Run: `BTG_POSTGRES_DSN="<the same DSN from external/yomal/dashboard/.env.local>" go test ./internal/db/... -run TestConnect -v`
Expected: both `TestConnect_LiveDatabase` and `TestConnect_InvalidDSN` PASS.

Do not hardcode the DSN into any file — pass it only as an inline environment variable for this manual run, exactly as shown.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/db/postgres.go internal/db/postgres_test.go
git commit -m "feat(db): add Postgres connection pool for the main repo"
```

---

### Task 4: End-to-end live verification

**Files:** none created or modified — this task is verification only, confirming Tasks 1-3 together produce what the spec promised.

**Interfaces:**
- Consumes: `ApplySchema` (Yomal's `internal/db/schema.go:318`, unchanged function, now running the expanded `schema` constant from Tasks 1-2), `Connect` (Task 3).
- Produces: nothing new — this is the checkpoint before this sub-project is considered done.

- [ ] **Step 1: Run the full, real schema application**

`ApplySchema` is currently only called from within `cmd/collect.go` and `cmd/seedadmin.go` (confirmed by grepping for `ApplySchema` across `external/yomal`) — both of those commands have real side effects beyond applying the schema (`collect` runs a live Azure collection; `seed-admin` inserts a user row if the given email doesn't already exist as an admin). Neither is a safe way to *just* apply the schema, so write a throwaway `main.go` instead — do not add a new permanent CLI command for this one-time check.

Create `external/yomal/CLI Engine/tmp_applyschema/main.go`:

```go
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/chanbistec/btg-devops/internal/db"
)

func main() {
	ctx := context.Background()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL not set")
		os.Exit(1)
	}
	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := db.ApplySchema(ctx, pool); err != nil {
		fmt.Fprintln(os.Stderr, "apply schema:", err)
		os.Exit(1)
	}
	fmt.Println("schema applied successfully")
}
```

Run it with the real DSN from `external/yomal/dashboard/.env.local`:

```bash
cd "external/yomal/CLI Engine"
DATABASE_URL="<value of DATABASE_URL from external/yomal/dashboard/.env.local>" go run ./tmp_applyschema
```

Expected: prints `schema applied successfully`, exits 0.

Delete `external/yomal/CLI Engine/tmp_applyschema/` immediately after — it must not be committed.

- [ ] **Step 2: Verify no existing rows were touched**

Using the same live-query pattern from Task 1 Step 3, confirm row counts for `users`, `audits`, `findings`, `analysis_requests`, `subscriptions` match what they were before this sub-project started (the very first counts captured back in Task 1 Step 3's "before" output).

- [ ] **Step 3: Verify every new/altered column and every new table, in one pass**

```sql
SELECT table_name, column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema='public'
  AND (
    (table_name='findings' AND column_name IN ('environment','location','monthly_cost','monthly_saving','remediation_status','owner'))
    OR (table_name='audits' AND column_name IN ('total_findings','critical_count','warning_count','info_count','resources_scanned','commands_run','total_steps','completed_steps'))
    OR (table_name='analysis_requests' AND column_name='summary')
    OR (table_name='users' AND column_name IN ('name','status','approved_at','approved_by'))
  )
ORDER BY table_name, column_name;

SELECT table_name FROM information_schema.tables
WHERE table_schema='public'
  AND table_name IN ('schedules','cost_snapshots','cost_fetch_requests','cost_snapshot_history');
```

Expected: 19 rows from the first query (6 `findings` + 8 `audits` + 1 `analysis_requests` + 4 `users` columns), 4 rows from the second.

- [ ] **Step 4: Confirm `users`' existing 3 rows are intact and correctly shaped**

```sql
SELECT email, role, is_active, name, status, approved_at, approved_by FROM users ORDER BY created_at;
```

Expected: 3 rows, the same 3 emails identified during spec work (`admin@bistecglobal.com` and two others), `name`/`status`/`approved_at`/`approved_by` present as columns with their defaults (`''`, `'approved'`, `NULL`, `NULL`) since these are backfilled defaults, not per-user data anyone has set yet.

- [ ] **Step 5: Run the Go connectivity test one more time for the record**

```bash
BTG_POSTGRES_DSN="<same DSN>" go test ./internal/db/... -v
```

Expected: PASS.

- [ ] **Step 6: No commit for this task**

This task is verification-only. If Step 2, 3, or 4 turns up an unexpected diff, stop and fix the relevant task before proceeding — do not paper over a mismatch here.
