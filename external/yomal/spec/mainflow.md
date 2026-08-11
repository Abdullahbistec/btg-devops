# btg-devops — Project Summary for Claude Code

## What This Project Is

btg-devops is a Go CLI tool (Cobra framework) that audits Azure infrastructure across 12 resource types. It is being built by a BISTEC Global intern as part of a structured internship program.

The goal of this platform is to surface problems a senior DevOps engineer would manually investigate — cross-resource inefficiencies, misconfigurations, cost waste, security gaps — automatically, by giving Claude a full clean picture of the entire Azure subscription at once. The cross-region example ($200/month Cosmos DB in East US called by App Service in West Europe) is one example of this class of problem, not a special case.

---

## Current State (v0.13.0 — Complete)

All of the following is already built and working:

- 12 analyzer modules in `cmd/` — storage, iam, nsg, acr, cosmosdb, keyvault, functions, publicip, appservice, appserviceplan, cognitiveservices, resourcegroup
- `btg-devops analyze [module]` — runs one analyzer
- `btg-devops analyze all` — runs all 12 analyzers in one command
- `btg-devops analyze cost` — queries Azure Cost Management API for billing data
- Unit tests for all 12 analyzers in `tests/`
- CI pipeline in `.github/workflows/ci.yml` — build, test, lint on every push/PR
- CHANGELOG.md, CONTRIBUTING.md
- Cross-platform release pipeline via git tags

Authentication uses 4 environment variables: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`

---

## What We Are Building Next (v0.14.0)

After extensive discussion, we redesigned the next phase. Here is the final architecture decision.

### Core Principle — Two Completely Separate Systems

**System 1 — CLI (data collection only)**
The CLI's only job is to fetch Azure data, clean it, and save it to a database. It does NOT call Claude. It does NOT print intelligent findings to the terminal anymore. It is purely a data collector.

**System 2 — Dashboard (all the intelligence)**
A Next.js web dashboard is the only place where Claude does any analysis. It reads saved audit data from the database and uses Claude to analyze, compare, and answer questions. Multiple users with different roles can access the dashboard.

---

## Why We Designed It This Way

We went through many iterations to reach this design. Key reasoning points:

1. **Raw Azure JSON is too large and noisy to send to Claude.** A single resource can have 200+ fields and ~4,000 tokens. We clean the raw JSON by removing known useless fields (etag, systemData, apiVersion, provisioningState, correlationId, operationId, internal ARM metadata) and keeping all real configuration and property fields. Claude decides what matters — we do not pre-select a small fixed set of fields, because that would make Claude a checklist checker instead of an investigator.

2. **Hardcoded Go rules are not removed from the codebase, but they are not part of the main CLI flow anymore.** They can act as a fallback only if Claude API becomes unavailable.

3. **We considered and rejected having Go compare old vs new audit data with complex "smart save" logic (5 rules: new finding/same finding/severity changed/finding resolved/overdue).** This was over-engineered. The final decision: every audit run just saves a fresh complete record to the database. No comparison logic in Go. The user decides when to compare audits — Claude does the comparing when asked, not Go automatically.

4. **We considered running "save to database" and "send to Claude" in parallel using goroutines, then rejected this entirely** — because Claude should not be called at all during the CLI run. Sending data to Claude immediately during CLI execution was identified as unnecessary; that intelligence work belongs only in the dashboard, triggered by user action.

5. **We considered using MCP (Model Context Protocol) to let Claude call tools and fetch data live, then rejected MCP entirely.** Reasoning: the dashboard already knows exactly what data to fetch from the database before calling Claude (it's either "the audit the user clicked" or "the audit relevant to the question asked"). There is nothing for Claude to discover or decide via tool-calling — we already have the data. MCP would add a server to build/host/maintain and an extra network round-trip for zero benefit in this design. **Decision: use the Anthropic API directly from the Next.js backend — no MCP server needed.**

6. **The platform's core value is finding problems nobody thought to hardcode.** Cross-resource patterns, cost inefficiencies, misconfigurations that span multiple resource types — these are things Claude can catch when given the full clean picture of the subscription, but no static rule can.

---

## Architecture Decisions Made (After Problem Review)

These decisions were reached after reviewing specific problems in the original plan:

### 1. Database — PostgreSQL on Supabase (not SQLite)
SQLite is a local file. The CLI runs in GitHub Actions (ephemeral cloud runner, destroyed after each run) and the API server runs persistently on Azure Container Apps. They cannot share a local file. PostgreSQL hosted on Supabase solves this — both the CLI runner and the API server connect to the same cloud database via `DATABASE_URL`. Free tier is sufficient for v1.

### 2. API Server Authentication — JWT with Multi-User, Multi-Role
The dashboard supports multiple users with different roles. A static API key is not enough. JWT is issued on login with the user's role embedded in the token. Every protected API route validates the JWT and checks the role.

**Roles:**
- `admin` — full access, manage users, see all audits
- `analyst` — view audits, run analysis, use chat
- `viewer` — read-only, see audit results only

Note: `github.com/golang-jwt/jwt/v5` is already an indirect dependency in `go.mod` — use it directly.

**New API endpoints for auth:**
- `POST /auth/login` — validates credentials, returns JWT
- `POST /auth/register` — creates user (admin only)
- JWT middleware validates token on every protected route
- Role middleware checks role before allowing access

**Database additions for auth:**
- `users` table — id, email, password_hash, role, created_at

**Dashboard additions for auth:**
- Login page
- JWT stored in httpOnly cookie
- JWT sent on every API call
- UI shows/hides elements based on role

### 3. API Server Hosting — Azure Container Apps
The company runs on Azure. The tool audits Azure. The API server runs on Azure. Azure Container Apps has a free tier and supports auto-deploy from GitHub Actions. No other hosting option was considered.

### 4. Extractor Design — Remove Noise, Keep Everything Real
The extractor's job is NOT to pick a small set of fields we think matter. The extractor's job is to remove fields that are definitely useless in every Azure SDK response, then keep all real configuration and property fields.

**Fields to remove from every resource (universal noise):**
- `etag`
- `systemData`
- `apiVersion`
- `provisioningState`
- `correlationId`
- `operationId`
- Full ARM resource IDs (the long `/subscriptions/xxx/resourceGroups/...` paths)

**Keep everything else** — all properties, configuration fields, location, SKU, tags, network settings, security settings, connection info, regions, tiers, policies.

This approach:
- Is simpler to build (one shared noise-remover + small per-resource trimmer)
- Is harder to get wrong (no risk of accidentally excluding an important field)
- Gives Claude the full picture to reason across resources
- Still massively reduces tokens (4,000 per resource → ~200-400 per resource)

**Structure:**
- `internal/extractors/cleaner.go` — shared function that removes universal noise fields from any resource
- `internal/extractors/storage.go`, `cosmosdb.go`, etc. — per-resource files that call the shared cleaner and remove any additional resource-specific noise

### 5. Claude Response Caching — Cache Per Audit in Database
Audit data does not change after it is saved. Claude's analysis of a fixed audit will always be the same answer. Calling Claude multiple times for the same audit wastes money.

**Fix:** Add a `claude_analysis` column (nullable JSON) to the `audits` table.

- First "Analyze" click on an audit → `claude_analysis` is NULL → call Claude → save response to `claude_analysis` → return to user
- Every subsequent click on same audit → `claude_analysis` is not NULL → return saved response directly → no API call

**Chat mode (Method 2) is NOT cached** — every question is unique.

---

## Final CLI Flow (System 1)

```
1. Trigger (scheduled via GitHub Actions cron, OR manual: btg-devops analyze all)
2. Go fetches raw JSON from Azure SDK (all 12 resource types)
3. Go cleans raw JSON via internal/extractors/
   - Removes universal noise fields (etag, systemData, apiVersion, etc.)
   - Keeps all real configuration and property fields
   - Reduces ~48,000 tokens to ~3,000-5,000 tokens total
4. Save the clean data to PostgreSQL (Supabase) as a new audit record
5. Done. No Claude call here. No terminal findings output anymore.
```

Note: The existing `btg-devops analyze [module]` command (single module terminal output) stays as-is and is considered separate/legacy — not part of this new pipeline.

---

## Final Dashboard Flow (System 2)

```
1. User opens the Next.js dashboard
2. User logs in → receives JWT with their role
3. Dashboard shows a list of all saved audits (via HTTP API Server reading PostgreSQL)
4. User chooses one of two methods:

   METHOD 1 — Normal Mode (click-based)
     User selects an audit → clicks "Analyze"
     Dashboard backend checks if claude_analysis is already cached in DB
     If cached → return cached response immediately (no API call)
     If not cached → fetch audit data from DB → send to Claude API directly
     → save Claude response to claude_analysis column → return to user
     Claude responds with findings, explanations, severity, cost impact, fix steps
     Dashboard renders this as visual cards + table

   METHOD 2 — Chat Mode (natural language)
     User types a free-form question
     ("Compare June 1 and June 15", "Why is cosmos-db critical?",
      "What's my biggest cost problem?", "Find problems across my system")
     Dashboard backend determines which audit(s) are relevant and fetches
     them from the DB
     Sends that data + the user's question to Claude API directly
     Claude answers in the chat
     Chat responses are NOT cached (every question is unique)

5. Claude's four jobs across both methods: AUDIT, ANALYZE, COMPARE, FIND PROBLEMS
6. Claude never calls any tools and never fetches data itself — the dashboard
   backend always fetches first, then hands data to Claude in the prompt.
```

---

## How Dashboard Talks to Claude (Important)

Direct Anthropic API integration — no MCP.

```typescript
// Conceptual pattern for dashboard/app/api/analyze/route.ts (Method 1)

import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const { auditId } = await request.json();

  // Step 1 — check cache first
  const audit = await db.getAudit(auditId);
  if (audit.claude_analysis) {
    return Response.json(audit.claude_analysis); // return cached, no API call
  }

  // Step 2 — call Claude with full clean audit data
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: `Azure audit data: ${JSON.stringify(audit.raw_data)}\n\nAnalyze this Azure subscription. Find all problems, inefficiencies, misconfigurations, and cost issues. Look across all resource types together — cross-resource patterns matter.`
    }]
  });

  // Step 3 — cache the response
  await db.saveClaudeAnalysis(auditId, response);

  return Response.json(response);
}
```

---

## Database Schema (PostgreSQL on Supabase)

```sql
-- Users table (for JWT auth)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Audits table
CREATE TABLE audits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  subscription_id TEXT NOT NULL,
  raw_data        JSONB NOT NULL,        -- clean Azure JSON (noise removed)
  claude_analysis JSONB DEFAULT NULL,   -- NULL until first Analyze click, then cached
  resource_counts JSONB DEFAULT NULL    -- summary counts per resource type
);
```

---

## Components to Build for v0.14.0

### Backend (Go) — System 1 + API Server
- `internal/extractors/cleaner.go` — shared noise-removal function (removes etag, systemData, apiVersion, etc.)
- `internal/extractors/*.go` — 12 per-resource files that call cleaner + remove resource-specific noise
- `internal/db/` — PostgreSQL connection, audit save, audit fetch functions
- CLI save pipeline — wire `cmd/all.go` to call: fetch → clean (extractors) → save (PostgreSQL). Remove terminal findings printing for this path.
- Scheduled trigger — `.github/workflows/scheduled-audit.yml`, cron-based, runs `btg-devops analyze all` automatically, uses `DATABASE_URL` secret
- HTTP API Server — `cmd/server.go`
  - `POST /auth/login` — returns JWT
  - `POST /auth/register` — admin only
  - JWT middleware on all protected routes
  - Role middleware on role-restricted routes
  - `GET /audits` — list all audits (analyst, admin)
  - `GET /audits/{id}` — fetch one audit's data (analyst, admin)
  - Deploy to Azure Container Apps

### Frontend (Next.js) — System 2 (Dashboard)
- Dashboard scaffold — Next.js 14+, TypeScript, Tailwind CSS, Recharts
- Login page — email/password → receives JWT → stores in httpOnly cookie
- Role-based UI — show/hide features based on JWT role
- Audit history view — list all saved audits with summary counts
- Method 1 — Analyze button — click → backend checks cache → if miss calls Claude → renders findings cards/table
- Method 2 — Chat interface — type question → backend fetches relevant audit(s) → sends to Claude → renders chat response
- Deploy to Vercel — env vars: `ANTHROPIC_API_KEY`, `API_SERVER_URL`

---

## Explicitly Removed From Scope

- **MCP Server (`cmd/mcp.go`)** — was originally planned, now removed. Reason: dashboard already knows what data to fetch before calling Claude; MCP's tool-discovery model adds unnecessary complexity and a round-trip for no benefit in this design.
- **Claude Agent (separate from API)** — not used; we use the plain Anthropic Messages API directly.
- **Smart save / comparison logic in Go (5-rule system)** — considered and rejected as over-engineered. Every audit just saves fresh; comparison is Claude's job, on-demand, when the user asks.
- **Parallel save+Claude execution during CLI run** — considered and rejected; Claude is never called during the CLI run at all.
- **SQLite** — considered and rejected. Cannot be shared between GitHub Actions (ephemeral) and the API server (persistent). Replaced with PostgreSQL on Supabase.
- **Static API key auth** — considered and rejected. Dashboard supports multiple users with different roles, so JWT is required.

---

## Deferred to Phase 3 (Future, Not Now)

- Slack integration for audit notifications
- Drift detection (`btg-devops drift`) — IaC vs live Azure config
- Runbook library in dashboard
- Audit comparison tool (visual side-by-side, complementing the chat-based comparison)
- `analyze usage` — Azure Monitor utilization + Cost Management combined, with per-resource drill-down (e.g. Cosmos DB account → per-database cost/RU breakdown)

---

## Tech Stack Summary

| Layer | Technology |
|---|---|
| CLI | Go, Cobra framework |
| Azure SDK | azure-sdk-for-go |
| Database | PostgreSQL — hosted on Supabase |
| Backend API | Go, net/http — hosted on Azure Container Apps |
| Auth | JWT — `github.com/golang-jwt/jwt/v5` (already in go.mod) |
| Dashboard | Next.js 14+, TypeScript, Tailwind CSS, Recharts |
| AI | Anthropic API (direct, no MCP) — model: claude-sonnet-4-6 |
| Hosting (dashboard) | Vercel |
| Hosting (API server) | Azure Container Apps |
| CI/CD | GitHub Actions |

---

## Environment Variables

| Variable | Used By | Purpose |
|---|---|---|
| `AZURE_TENANT_ID` | CLI | Azure auth |
| `AZURE_CLIENT_ID` | CLI | Azure auth |
| `AZURE_CLIENT_SECRET` | CLI | Azure auth |
| `AZURE_SUBSCRIPTION_ID` | CLI | Azure subscription target |
| `DATABASE_URL` | CLI + API Server | PostgreSQL connection string (Supabase) |
| `JWT_SECRET` | API Server | Sign and verify JWT tokens |
| `ANTHROPIC_API_KEY` | Next.js dashboard | Claude API calls |
| `API_SERVER_URL` | Next.js dashboard | Go API server base URL |

---

## What I Need From You (Claude Code)

When I ask you to build a specific piece (extractors, database schema, CLI pipeline wiring, HTTP API Server, dashboard components, or the Claude API integration), please:

1. Read the existing project structure first before writing anything
2. Match existing code style and patterns already used in the project
3. Follow the architecture described above exactly — especially:
   - CLI/Dashboard separation (CLI never calls Claude)
   - No MCP (direct Anthropic API only)
   - Extractor approach (remove noise, keep everything real — do not pre-select 8 fields)
   - PostgreSQL via Supabase (not SQLite)
   - JWT auth with admin/analyst/viewer roles
   - Claude response caching in the `claude_analysis` DB column
4. Ask me before making any extra architectural decisions not covered in this summary
