# Backend Engineering Review — btg-devops

**Date:** 2026-09-17
**Reviewer role:** Senior software engineer, whole-backend review (architecture, code quality, correctness, maintainability, operability). Security is covered separately in `docs/security-assessment-2026-09.md`; this review references it rather than repeating it.
**Surfaces:** Go CLI + MCP server (`cmd/` — 48 non-test files, `provider/`, `main.go`) and the Next.js dashboard backend (`web/app/api/**`, `web/lib/**`, ~960-line `db.ts`).

---

## Overall verdict

**This is a mature, well-built backend — above the median for an internal tool.** The Go side has a clean plugin architecture with proper failure isolation; the TS side has careful connection-pool lifecycle handling, a sensible async job-queue pattern, strong typing, and — notably — some of the best explanatory comments I've seen in a codebase this size (they document *why*, including past incidents). Security is strong and independently verified. Test discipline is good (223 unit + 20 E2E + Go tests, all green).

The weaknesses are the usual ones for a product that grew fast and migrated datastores: **no database migration framework, a god-module data layer, timestamps stored as TEXT, and an in-process scheduler with no multi-instance story.** None are on fire; all are worth scheduling before the team or the estate grows.

---

## Architecture

### Go CLI + MCP server — strong
- **Cobra command tree** (`analyze <service>`), one file per Azure/Hetzner/PP service. Each registers a `provider.Analyzer` into a provider-scoped registry (`provider/registry.go`).
- **`provider.Run` isolates failures**: `runSafely` recovers panics into errors, and one analyzer failing (or panicking) doesn't stop the others — findings and errors are collected side by side. This is exactly right for a "scan everything, report what you can" tool.
- **Engine abstraction** (`--engine claude|rules`, default claude with fallback to rules) is a clean seam for swapping the reasoning layer.
- **MCP server** exposes the same capability over stdio and Streamable HTTP, with a required bearer token on the HTTP path.

Verdict: idiomatic, extensible, production-shaped. The main nit is that `cmd/` is one flat 48-file package; grouping by domain (or moving analyzers under `internal/azure`, `internal/hetzner`) would help navigation, but Cobra convention makes the flat layout defensible.

### Next.js backend — good, with a heavy data layer
- Clean request path: **route handler → `lib/*` domain module → `db.ts`**. Handlers are mostly thin.
- **Async job queue** for slow work: the dashboard writes an `analysis_request` / `cost_fetch_request` row; a Claude Code agent polling through the MCP server picks it up, reasons, and writes back via `/api/internal/*`. This decouples the UI from LLM/cloud latency — a good pattern well executed.
- **Connection pool** (`getDB`) is carefully done: single pool, cached readiness promise, idle-error listener (so a Postgres blip doesn't crash the Next process), and it *resets* the pool if schema init fails so one transient boot failure doesn't poison every later call. This is senior-level defensive code.

---

## Findings (engineering, not security)

### 🟠 E-1 — No database migration framework
- **Where:** `web/lib/db.ts` `initSchema()` — `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`, run on every boot.
- **Problem:** This only ever *creates* missing objects. It cannot evolve an existing table — adding, renaming, re-typing, or backfilling a column needs out-of-band SQL, and there's no record of what has been applied where. As the schema changes, dev/stage/prod drift silently, and a column added in code but not in an existing DB fails at query time, not at boot.
- **Impact:** The single biggest maintainability risk. It gets worse with every schema change and every environment.
- **Recommendation:** Adopt a lightweight migration tool — `node-pg-migrate` or Drizzle — with a `schema_migrations` table and versioned, ordered files. Keep `initSchema` only as the bootstrap for a brand-new DB, or fold it into migration 0001. *Adopt now, before the next schema change.*

### 🟠 E-2 — `db.ts` is a ~960-line god-module
- **Where:** `web/lib/db.ts` — subscriptions, audits, findings, users, analysis requests, cost snapshots (Azure + Hetzner + history), cost-fetch requests, and dashboard aggregates all in one file.
- **Problem:** High cognitive load, merge-conflict magnet (relevant given the concurrent branches in flight), and it blurs domain boundaries — everything can touch everything.
- **Recommendation:** Split into per-domain repositories (`db/audits.ts`, `db/findings.ts`, `db/users.ts`, `db/cost.ts`) sharing the one `getDB()` pool. Pure refactor, no behavior change; do it incrementally. *Adopt next.*

### 🟡 E-3 — Timestamps stored as TEXT, not `timestamptz`
- **Where:** 23 columns default to `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`; only ~5 use real timestamp types.
- **Problem:** A carryover from the SQLite→Postgres migration (the comments say as much). String timestamps lose timezone, sort lexically (works only because the format is fixed-width), and can't do interval math in SQL (`WHERE completed_at > now() - interval '1 day'`), forcing that logic into JS. It's a latent correctness trap the day a format or timezone assumption slips.
- **Recommendation:** Migrate the timestamp columns to `timestamptz` (naturally, as part of adopting E-1). *Adopt next.*

### 🟡 E-4 — Scheduler runs in-process with no multi-instance lock, and reaches live cloud on every boot
- **Where:** `web/lib/scheduler.ts` — 60s poll loop inside the Next.js server.
- **Strengths:** genuinely thoughtful — self-heals by re-checking each cycle, skips cost refresh while an audit runs (avoids stacking tenant-rate-limited calls), and marks stale `running` audits as failed after a max age. Good operability instincts.
- **Problems:** (a) It runs inside every server instance with **no distributed lock**, so a horizontally-scaled deploy would run every schedule N times. (b) It starts on process boot, so **`npm run dev` makes live Azure Cost Management calls** (observed hitting rate limits during E2E) — noisy and quota-consuming locally.
- **Recommendation:** Gate the scheduler behind an env flag (`ENABLE_SCHEDULER`) off by default in dev; for multi-instance, take a Postgres advisory lock (`pg_try_advisory_lock`) around each cycle so exactly one instance runs it. *Adopt next.*

### 🟡 E-5 — JSON payloads stored as TEXT, not `jsonb`
- **Where:** `commands_run TEXT DEFAULT '[]'` and the cost-breakdown blobs; parsed with `JSON.parse` + try/catch in routes (e.g. `findings/route.ts`, `resolveLatestAuditForScope`).
- **Problem:** No DB-side validation or queryability; every read is a parse-and-hope. `jsonb` would validate on write and allow server-side filtering (e.g. "audits whose `commands_run` contains X") instead of pulling 25 rows and filtering in JS.
- **Recommendation:** Move these to `jsonb` with E-1. *Adopt later.*

### 🟢 E-6 — One route still returns raw error text
- **Where:** `web/app/api/admin/notify/route.ts` still uses `(e as Error).message`; every other route adopted the `apiError()` / `logServerError()` helper from the security remediation.
- **Recommendation:** Convert the straggler to `apiError()`. *Adopt now — one line.*

### 🟢 E-7 — Integers used as booleans
- **Where:** `is_active INTEGER DEFAULT 1`, `enabled INTEGER`, `is_active` in subscriptions/schedules — another SQLite artifact.
- **Recommendation:** Use Postgres `boolean` when the columns are migrated. Cosmetic; low priority. *Adopt later / opportunistically.*

---

## What's done well (keep doing it)

- **Failure isolation** in the Go analyzer registry (panic recovery, per-analyzer error collection).
- **Pool lifecycle** in `db.ts` — idle-error handling and poison-avoidance on failed schema init.
- **The async job-queue** decoupling of dashboard ↔ LLM/cloud work.
- **Comments that explain *why***, including past-incident context — this is real institutional knowledge captured in code, and it's rare. Preserve it through the refactors above.
- **Parameterized SQL everywhere**, `execFile` (no shell) for the Go binary, constant-time token checks — the security fundamentals are right.
- **Test coverage and green gates**: 223 unit, 20 E2E, Go tests, `npm audit`/`govulncheck` clean.

---

## Suggested sequencing

1. **Now (cheap, high-leverage):** E-6 (one-line straggler); introduce a migration tool and capture the current schema as migration 0001 (E-1); flag-gate the scheduler in dev (E-4a).
2. **Next (this quarter):** split `db.ts` into repositories (E-2); migrate timestamps to `timestamptz` (E-3) and add the scheduler advisory lock (E-4b) as part of the same migration effort.
3. **Later / opportunistic:** `jsonb` for JSON columns (E-5), `boolean` for int-flags (E-7), and consider grouping the `cmd/` package by domain.

None of these block shipping. They're the difference between a codebase that's healthy now and one that stays healthy as the schema, the estate, and the team grow.
