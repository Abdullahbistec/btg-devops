# Power Platform Support for Yomal's Dashboard — Design

Date: 2026-08-17
Branch: abd-production-2

## Context

`external/yomal/dashboard` is a separate, standalone product from our main
`web/` dashboard: Next.js 16 App Router, Postgres (Supabase) instead of
SQLite, its own Go collector at `external/yomal/CLI Engine` (module
`btg-devops-collector` or similar, using `pgxpool` to write directly to
Postgres). A prior investigation
(`docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md`)
established that this `CLI Engine` copy is a genuinely separate, standalone
Go module from our root `cmd/` — not something to be unified with it. This
design treats the two as separate systems and proposes **porting analyzer
logic** (not merging modules).

Today, Yomal's dashboard is Azure-only end to end:

- `subscriptions` table: one row per Azure subscription (subscription_id,
  tenant_id, client_id, client_secret_enc).
- `CLI Engine/cmd/collect.go`: reads a subscription row, runs 12 Azure
  extractors, writes one `audits` row + `findings` rows to Postgres.
- Dashboard: `Sidebar.tsx` nav is Dashboard / Audits / Cost & Usage /
  Data Gaps / Subscriptions / Users / Notifications — no Power Platform
  anywhere, and `audits`/`findings`/`subscriptions` all assume an Azure
  subscription shape.

Our own root `cmd/` (the main btg-devops Go CLI) already has working,
tested Power Platform analyzers — `pp-environments`, `pp-apps`, `pp-flows`,
`pp-powerbi` — that call the real Microsoft admin APIs and are verified
working against the real BISTEC tenant (see this session's live
`pp-powerbi` run: 200 workspaces, 318 reports, 333 datasets returned).
Those analyzers currently print/return results for our SQLite-backed `web/`
dashboard; they have no Postgres-writing path.

This design ports that analyzer *logic* (API calls, finding rules) into
Yomal's `CLI Engine`, so Yomal's dashboard gains native Power Platform
support without depending on our binary or our database at runtime.

## Goals

- A Power Platform tenant can be onboarded in Yomal's dashboard the same way
  an Azure subscription is today (Subscriptions page, admin-only).
- Running an audit on that tenant collects environments, apps, flows, and
  Power BI workspace data and writes it as `audits` + `findings` rows, using
  the existing schema unchanged downstream (Claude analysis, chat, exports
  all keep working with zero changes, since they operate generically on
  `audit_id`/`findings`).
- A dedicated "Power Platform" page shows PP audits and their findings,
  tabbed by resource type (Environments / Apps / Flows / Power BI).
- No regression to existing Azure audit behavior.

## Non-goals

- No change to our own `web/` (SQLite) dashboard — it already has PP
  support via the CLI's `pp-*` commands and `power-automate` page.
- No unification of the two Go modules (`cmd/` vs `CLI Engine`) — logic is
  ported/duplicated, not shared via a common package, per the prior
  investigation's conclusion that these stay separate systems.
- No new Claude-analysis logic — the existing `analysis_requests` queue and
  MCP/routine flow already operate generically on any `audit_id`/scope.

## Data model changes (Postgres, `CLI Engine/internal/db/schema.go`)

```sql
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'azure'
  CHECK (type IN ('azure', 'power_platform'));
ALTER TABLE subscriptions ALTER COLUMN subscription_id DROP NOT NULL;
```

- Existing rows: unaffected (`type` defaults to `'azure'`, `subscription_id`
  stays populated).
- A Power Platform row: `subscription_id = NULL`, `tenant_id` = the PP
  tenant's Azure AD tenant ID, `client_id`/`client_secret_enc` = the
  `BTG_PP_*` service principal's credentials (encrypted the same way Azure
  secrets already are, via `app/api/utils/crypto.ts`), `name` = a
  human label (e.g. "BISTEC Power Platform Tenant").
- `audits.subscription_id` (already `TEXT`, not a foreign key) stores the PP
  tenant ID for PP audits — no schema change needed there.
- No changes to `findings` — `resource_type` is already free-text; new
  values used: `"Power Platform Environment"`, `"Power App"`,
  `"Power Automate Flow"`, `"Power BI Workspace"`.

## Go collector changes (`CLI Engine`)

- New package `internal/extractors/powerplatform/` with four files mirroring
  our root `cmd/pp_environments.go`, `pp_apps.go`, `pp_flows.go`,
  `pp_powerbi.go` — same API endpoints/auth/finding rules, restructured to
  return Go structs (`[]Finding`) instead of printing a table, matching the
  existing `internal/extractors/*.go` Azure extractor shape so `collect.go`
  can call them uniformly.
- `internal/db/subscription.go`: `SubscriptionCredentials` gains a `Type`
  field read from the new column.
- `cmd/collect.go`: after loading the subscription row, branch on
  `sub.Type` — `"azure"` keeps today's 12-extractor path unchanged;
  `"power_platform"` calls the four new PP extractors instead. Same
  `audits` row shape either way (`raw_data` holds the combined PP payload
  under type-specific keys: `environments`, `apps`, `flows`, `powerbi`).
- Auth: PP extractors need OAuth scopes distinct from Azure ARM
  (`https://service.powerapps.com/.default`,
  `https://service.flow.microsoft.com/.default`,
  `https://analysis.windows.net/powerbi/api/.default`,
  `https://graph.microsoft.com/.default` — see
  `docs/013-powerplatform-setup.md`'s Token Scopes Reference in the main
  repo). Token acquisition logic is ported alongside the extractors.
- No new Cobra command — same `collect --subscription-id <row-id>` entry
  point for both types, since branching happens on the row's `type`.
- No new trigger mechanism — the dashboard's existing "Run Audit" button
  already dispatches a GitHub Actions `workflow_dispatch` that invokes
  `collect --subscription-id <row-id>` (see `app/api/controllers/audit.ts`,
  `process.env.GITHUB_DISPATCH_TOKEN`); a PP-type row goes through the
  identical button/endpoint/workflow, only branching inside `collect.go`
  itself.

## Dashboard changes

- `app/components/Sidebar.tsx`: new `navItems` entry — `{ label: 'Power
  Platform', href: '/power-platform', icon: Blocks }` — visible to the same
  roles as Audits (not admin-gated).
- New `app/power-platform/page.tsx`: list of PP-type audits, modeled on
  `app/audits/page.tsx` (same card/table conventions, filtered to
  `subscriptions.type = 'power_platform'`).
- New `app/power-platform/[id]/page.tsx`: audit detail, modeled on
  `app/audits/[id]/page.tsx`, with four tabs (Environments / Apps / Flows /
  Power BI) filtering the same audit's `findings` by `resource_type`
  instead of the Azure detail page's resource-group grouping.
- `app/subscriptions/page.tsx`: onboarding form gets a type toggle
  (Azure / Power Platform). Selecting Power Platform hides the
  subscription-ID field and relabels tenant/client/secret fields for a
  service principal instead of a subscription.
- No changes needed to `AnalysisPanel.tsx`, `ChatPanel.tsx`, or the
  `analysis_requests` API routes — they already operate generically on
  `audit_id` and a `scope` string.

## Rollout & testing

- Migration is additive and backward-compatible; safe to run against the
  live Supabase database (same `ApplySchema`, idempotent `IF NOT EXISTS`
  pattern already used for every other column in this schema).
- Go: unit tests for the four new PP extractors (reuse fixture/mocking
  patterns from our root `cmd/pp_test.go`), plus a test asserting
  `collect.go` branches correctly on `sub.Type`.
- Manual end-to-end (this session's environment): add the real BISTEC PP
  tenant as a `power_platform`-type subscription row via the UI, trigger a
  collect run, confirm real `audits`/`findings` rows appear in Supabase,
  confirm the new `/power-platform` page renders them correctly.
- No feature flag needed — the new nav item and page simply have nothing to
  show until a PP-type subscription exists, so this ships safely with zero
  PP tenants onboarded.

## Open questions for implementation time

- Exact Postgres connection path for local testing — reuse the same
  Supabase `DATABASE_URL` already in `external/yomal/dashboard/.env.local`,
  or a matching `.env` for `CLI Engine` itself (it reads `DATABASE_URL`
  independently as a Go env var, confirmed in `collect.go`).
- Whether `client_secret_enc` for the PP row should reuse the existing
  `BTG_PP_CLIENT_SECRET` value already used in `web/.env.local` for our main
  dashboard, or be treated as a fresh input during onboarding (recommend
  reusing the same real, already-working service principal rather than
  creating a second one).
