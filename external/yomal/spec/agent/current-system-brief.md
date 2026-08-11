# Current Analyzer System Brief — MCP + Claude Code (as of 2026-07-26)

> **Purpose.** This is the single onboarding document for anyone (human or agent) about to *enhance* the
> AI analysis pipeline. It describes what exists **today**, verified against the code — not what the
> specs propose. Every claim below is traceable to a file path given inline.
>
> **Read order for an enhancement task:** this file → `spec/agent/deep-research-playbook.md` (the
> agent's actual instructions) → `spec/handoff/15-analyzer-upgrade-plan.md` (execution status) →
> the specific spec (08/10/13/14) for the *why* behind a decision.
>
> **Terminology note.** "Claude Code" here means the **hosted scheduled routine** product
> (claude.ai/code/routines), not the local CLI. "MCP" means this project's own MCP server, which is
> a Next.js route inside the dashboard — not a separate process.

---

## 1. One-paragraph summary

Azure data collection is a Go CLI that writes to Postgres. Analysis is **not** performed by the
dashboard's backend; the dashboard only writes a **work-queue row** (`analysis_requests`). A
**scheduled Claude Code cloud agent** ("routine") wakes up, calls back into the dashboard through an
**MCP server exposed at `/api/mcp`**, pulls the scoped Azure data plus an instruction string, reasons
over it using a 5-stage deep-research playbook, and writes findings back through a `save_analysis`
MCP tool. The dashboard's read path never changed — it still reads the `claude_analysis` JSONB column
and the `findings` table. The whole design exists because **the project has a Claude Pro/Max
subscription but no paid Anthropic API key**, and free-tier LLMs produced corrupted output in
production.

---

## 2. Why the architecture is shaped this way (hard constraints — do not re-litigate)

From `spec/handoff/08-mcp-claude-orchestrator.md`:

| Constraint | Consequence |
|---|---|
| No paid Anthropic API key (procurement blocker, not technical) | Analysis cannot be metered API calls |
| Free-tier LLMs proved unreliable — a real incident produced garbled/corrupted JSON from a free OpenRouter model (audit `7cacf9a8`, `cosmosdb` scope) | Free models are banned from the Analyze path in production |
| A Claude Pro/Max subscription **is** available | Scheduled cloud agents are the supported, in-ToS way to use it programmatically |
| Spawning the `claude` CLI as a subprocess was evaluated and **rejected** | ToS risk + requires babysitting a persistent authenticated session, for no cost advantage |

Two second-order consequences that constrain enhancements:

1. **Analyze is asynchronous by nature.** It is "ready within minutes", not "ready in 5 seconds". Any
   enhancement that assumes synchronous analysis is fighting the architecture.
2. **Chat is explicitly out of scope** and still uses the free-model fallback chain. Do not "fix" Chat
   as a side effect of an analyzer change.

---

## 3. End-to-end flow (verified against code)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 1. COLLECT — Go CLI (`CLI Engine/cmd/collect.go`)                             │
│    Azure ARM/Monitor/Cost APIs → extractors → cleaned JSON                    │
│    Writes: audits.raw_data (per resource type), cost_data, usage_data,         │
│            audits.scope_hashes (SHA-256 per scope, spec 14)                   │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ same transaction-ish flow, best-effort
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 2. QUEUE — `db.QueueAnalysisRequests` (collect.go ~L355-392)                   │
│    One `analysis_requests` row per scope that actually collected data:         │
│      • each resource type with resourceCounts[key] > 0                        │
│      • "cost"      (if costData.TotalRows > 0)                                │
│      • "usage:<slug>" per type with metrics                                   │
│    NEVER queues "all" — that only comes from the dashboard button.            │
│    Each resource-type row gets cache_hit=true if its scope_hash matches the    │
│    last analyzed audit AND the 7-hit staleness streak isn't exhausted.         │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ then immediately:
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 3. FIRE — `triggerAnalyzerRoutine` (collect.go L37; TS twin in               │
│    `dashboard/app/api/utils/analyzerRoutine.ts`)                              │
│    POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire           │
│    Headers: Authorization: Bearer $ROUTINE_TRIGGER_TOKEN                      │
│             anthropic-version: 2023-06-01                                     │
│             anthropic-beta: experimental-cc-routine-2026-04-01                 │
│    Routine ID: trig_016EuQk8v8sTJT8oiYrHbJau (override: ANALYZER_ROUTINE_ID)   │
│    Best-effort — a failure is a warning, never fails the audit. The routine's  │
│    own daily cron is the fallback.                                            │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 4. ANALYZE — hosted Claude Code routine `btg-devops-mcp-analyzer`              │
│    ⚠️  ITS PROMPT LIVES ON claude.ai/code/routines — NOT IN THIS REPO.         │
│    It points at `spec/agent/deep-research-playbook.md` for the method.         │
│    Loop: list_pending_requests → get_audit_data → reason → save_analysis       │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ MCP over HTTPS, bearer token
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 5. MCP SERVER — `dashboard/app/api/mcp/route.ts` + `tools.ts`                  │
│    Stateless: one HTTP request = one throwaway McpServer + transport.          │
│    6 tools (§5). save_analysis reuses the SAME `saveAnalysisResult` the old    │
│    synchronous path used, so the findings lifecycle is identical.              │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 6. READ — unchanged. `AnalysisPanel.tsx` polls the request every 7s            │
│    (POLL_INTERVAL_MS = 7000), then renders `claude_analysis` / findings.       │
│    Side effects on completion: consolidated summary email; routine re-fired    │
│    if cost/usage scopes just became unblocked.                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. The MCP server — exact shape

**File:** `dashboard/app/api/mcp/route.ts`

- Runs **inside the dashboard's Vercel deployment**, `export const runtime = 'nodejs'`. This is a
  deliberate reversal of spec 8's "needs a persistent host" claim: because the transport is stateless
  (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), one request maps cleanly onto a
  serverless handler with no code compromise.
- Server identity: `{ name: 'btg-devops-mcp', version: '1.0.0' }`.
- Transport: `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true` — each request
  is one buffered JSON response, so `transport.close()` / `server.close()` in `finally` is safe
  (an SSE stream would be cut off mid-flight there).
- **Auth:** single shared secret `MCP_BEARER_TOKEN` compared against `Authorization: Bearer …`.
  Missing env var → 500. Wrong token → JSON-RPC `-32001 unauthorized`, HTTP 401.
- `GET` returns 405 (no SSE stream to resume). `POST` only.
- **No per-user auth, no rate limiting, no audit log of MCP calls.** The token is the entire security
  boundary and it grants full read of every audit's Azure data plus write access to findings.

### The 6 tools (`dashboard/app/api/mcp/tools.ts`)

| Tool | Inputs | Returns / effect |
|---|---|---|
| `list_pending_requests` | `limit` (1–100, default 20) | Pending rows, oldest first. **Side effect:** calls `resolveCachedAnalysisRequests(limit)` first, silently carrying forward any `cache_hit` rows — the agent never sees them. |
| `get_audit_data` | `auditId`, `scope` | `{ data, instruction }` from `getScopedAuditData`. This is where the whole prompt reaches the agent. |
| `list_changed_scopes` | `auditId` | `[{ scope, changed }]` — fresh hash comparison for every scope in `scope_hashes`. `"all"`-fan-out only. |
| `get_cached_scope_analysis` | `auditId`, `scope` | The prior audit's saved analysis for an unchanged scope, or `null`. `"all"`-fan-out only. |
| `get_audit_history` | `auditId`, `scope?`, `limit` (default 300, max 1000) | Every finding (open/dismissed/resolved) across past audits of the **same subscription**, oldest first. Backs playbook Stage 4. |
| `save_analysis` | `auditId`, `scope`, `summary`, `findings[]`, `model` (default `"claude-code-orchestrator"`), `data_gaps?` | Persists via `saveAnalysisResult`, marks the pending request `done`, sends the audit-complete email if this was the last scope, re-fires the routine if cost/usage just unblocked. On throw: marks the request `failed` and returns `isError`. |

**Design principle stated in the file:** "no business logic lives here" — the tools are thin wrappers
over existing model/util functions. **Preserve this.** An enhancement that puts reasoning or data
shaping into `tools.ts` breaks the invariant that the sync path and the MCP path can never drift.

---

## 5. The queue (`analysis_requests`) — semantics that matter

**Schema** (`CLI Engine/internal/db/schema.go` L177-200):

```sql
CREATE TABLE analysis_requests (
  id UUID PK, audit_id UUID FK→audits ON DELETE CASCADE,
  scope TEXT NOT NULL,
  status TEXT CHECK (status IN ('pending','done','failed')) DEFAULT 'pending',
  error_message TEXT, requested_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
ALTER TABLE analysis_requests ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN NOT NULL DEFAULT FALSE;
```

**Model layer:** `dashboard/app/api/models/analysisRequests.ts`

Three non-obvious behaviors an enhancement will trip over:

1. **Cost/usage scopes are deliberately held back.** `listPendingAnalysisRequests` excludes
   `cost` / `usage` / `usage:%` rows for an audit while **any** non-cost/usage scope for that same
   audit is still pending. Rationale: cost/usage findings are only good once the agent has the full
   resource picture. The moment the last blocker resolves, `hasNewlyUnblockedCostUsage` fires and
   `save_analysis` re-triggers the routine so those rows don't wait for the next cron tick.
2. **`cache_hit` is set at insert and never changed.** It's only a *marker*. Nothing skips work by
   reading the column directly — carry-forward is done by `resolveCachedAnalysisRequests`.
3. **Staleness ceiling = 7, implemented twice.** `CACHE_STALENESS_CEILING = 7` in TS and
   `db.CacheStalenessCeiling = 7` in Go, kept in sync **only by a comment cross-reference**. Both
   count consecutive `cache_hit=true` requests backwards from the current audit for that scope. If
   you change one, you must change the other.

**Two independent insert paths** — both must stay in agreement about what "analyzed" means (most
recent *prior* audit of the same subscription with a `status='done'` request for that exact scope):

- Go: `collect.go` auto-queue → `db.PreviousAnalyzedScopeHash` + `db.TrailingCacheHitStreak`
- TS: `createAnalysisRequestController` (`dashboard/app/api/controllers/audit.ts` L377) →
  `checkScopeCacheHit`

---

## 6. What the agent actually receives — prompt assembly

This is the highest-leverage surface for quality work. **All of it comes out of one function:**
`getScopedAuditData` in `dashboard/app/api/utils/claude.ts` (L367).

### Scope taxonomy

| Scope | Data source | Notes |
|---|---|---|
| `<resource type>` (storage, iam, nsg, acr, cosmosdb, keyvault, functions, publicip, appservice, appserviceplan, cognitiveservices, resourcegroup, cdn, vm, inventory) | `audits.raw_data[scope]` | Gets a per-type checklist |
| `cost` | `cost_data` column | Own DB column, never in raw_data |
| `usage:<type>` | `usage_data` filtered via `buildUsageGroups` | Per-type utilization |
| `usage` | legacy combined | Kept only so old cache entries resolve |
| `all` | raw_data + cost + usage merged | Only from the manual "analyze everything" button |
| `deep` | alias of `all` | Legacy; kept so pre-spec-10 saved analyses/requests resolve |

### The instruction string is composed of up to 5 parts

1. **Base scope instruction** — e.g. `Analyze the "storage" resources in this Azure subscription as a
   senior DevOps engineer would…`
2. **`checklistForType(scope)`** — `dashboard/app/api/utils/analysisChecklists.ts`, 15 resource types
   with ~10–15 CIS/Well-Architected checks each. **Single-resource-type scopes only.**
3. **`PRECOMPUTED_SIGNALS_NOTE`** — appended when `precomputed_signals` is present. Tells the agent
   these are deterministic ground truth (don't recompute the math), with one carve-out:
   `reserved_instance_candidates` is only a *stability* signal, not a recommendation.
4. **`DEEP_RESEARCH_DIRECTIVE`** — points at the 5-stage playbook, mandatory for **every** scope.
5. **`SEVERITY_RUBRIC`** — Critical/Warning/Info definitions, the "tie-break low" rule, and the
   evidence requirement.

> ⚠️ **Known inconsistency to be aware of:** the two branches append these in different orders. For
> `all`/`deep`: base → DIRECTIVE → RUBRIC, then signals note. For every other scope: base →
> checklist → signals note, then DIRECTIVE → RUBRIC. Functionally minor, but if you're doing
> prompt-position experiments this is a confound.

### `precomputed_signals` — deterministic facts injected alongside the data

Built by `buildPrecomputedSignals` (claude.ts L300) from `costInsights.ts` / `usageInsights.ts`.
Empty arrays are omitted so a quiet subscription doesn't bloat the payload.

| Key | Detector | Requires |
|---|---|---|
| `zombie_spend` | `detectZombieSpend` | cost rows + inventory |
| `spend_spikes` | `detectSpendSpikes` | cost rows |
| `service_concentration` | `detectServiceConcentration` | cost rows |
| `cost_period_comparison` | `compareCostPeriods` | cost rows + previous audit's cost |
| `cost_forecast` | `forecastCost` | cost rows |
| `cost_by_resource_group` / `cost_by_tag` | rollups | cost rows + inventory |
| `reserved_instance_candidates` | `detectReservedInstanceCandidates` | cost rows |
| `idle_resources` | `detectIdleResources` | usage metrics |
| `usage_period_comparison` | `compareUsagePeriods` | usage metrics + previous |
| `cost_usage_waste` | `detectCostUsageWaste` | **both** cost and usage |

**These detectors cost zero agent time and run on every audit regardless.** The Cost & Usage page runs
entirely on them — no agent involved (spec 14, explicitly out of scope).

### The playbook — `spec/agent/deep-research-playbook.md` (299 lines)

Five mandatory stages, no fast/one-shot mode exists:

1. **Build the map** — environments (prod/dev/QA inferred from names, RGs, tags), regions,
   application groupings, spend shape. Report nothing yet.
2. **Correlate datasets** — config × cost × usage for the *same* resource. Every finding here needs a
   derived `cost_impact_usd` with arithmetic shown in `evidence`.
3. **Chain into attack paths** — public entry point → managed identity → Key Vault → prod secrets.
   Reported as **ONE** finding with `finding_type: "chain"`. This subscription has zero VMs, so all
   chains run through PaaS identities.
4. **Judge in context** — same misconfig is Critical in prod and Info in sandbox; call
   `get_audit_history` for "open for N audits" trends. An empty history is normal, not a data gap.
5. **Verify then report** — actively try to **refute** every Critical; prefer few well-evidenced
   findings; record `data_gaps` for anything needed but unavailable.

Plus **three addenda** (2026-07-12) listing data added since earlier runs (site security/auth config,
storage containers + lifecycle, `inventory` scope, `cdn` scope, `vm` scope, cosmosdb RU pricing,
functions `auth_level`, cognitiveservices metrics, 90-day cost history) and — importantly — three
gaps that are **intentionally not collectible** and should keep being reported:
App Settings values (403, deliberate access decision), principal-ID → display-name (needs Graph
consent), blob content inspection (deliberate privacy non-goal).

---

## 7. The finding contract

Defined in three places that must stay aligned:
`AnalysisFinding` (claude.ts L35) · `findingSchema` zod (tools.ts L23) · `findings` table + `insertFinding`.

| Field | Notes |
|---|---|
| `severity` | `Critical` \| `Warning` \| `Info`. Invalid values are silently dropped by `saveFindings`. |
| `category` | Security / Cost Waste / Misconfiguration / Governance / Performance |
| `resource_type`, `resource_name` | For account-based types (cosmosdb, storage, appserviceplan) `resource_name` is the **account/plan** |
| `resource_group` | Read straight off the resource's own `resourceGroup` (attached by `cleaner.go`) |
| `child_resource_name` | Account-based types only — the specific DB/container/app |
| `affected_resources[]` | Same issue across many resources → **one** finding listing them all. Populated by the model, never derived post-hoc (issue wording varies run to run) |
| `cost_impact_usd` **or** `cost_impact_note` | Exactly one; note is a label like `"security risk"` |
| `issue` | Plain English, for a non-technical reader, **no raw field names** |
| `evidence` | The exact field/value proving it. Required. Rendered as its own "why this is flagged" section |
| `recommendation_steps[]` | Max 4 imperative steps — the field the UI renders |
| `recommendation` | Legacy flat string, **derived** by joining steps. Kept for exports/email/chat |
| `fix_effort` | quick \| moderate \| complex — cost to **fix**, deliberately independent of severity. Powers "Quick wins" |
| `finding_type` | `"chain"` renders a distinct headline card; absent/`"standard"` otherwise |

Top-level on the analysis: `summary`, `generated_at`, `model`, `data_gaps[]`.

### Findings lifecycle — `saveFindings` (claude.ts L237). Four behaviors, all load-bearing:

1. **Replace, don't append** — `deleteFindingsByScope(auditId, scope)` first, so re-analysis never duplicates.
2. **Age carry-forward** — if the same `findingKey` (`resource_type|resource_name|category`, lowercased;
   *not* issue text, which the LLM words differently every run) was open in an earlier audit of the
   same subscription, the new row inherits `first_seen_at` and the superseded older row is deleted.
3. **Sticky dismissals** — a matched prior row that was `dismissed` keeps that status. New audits never
   resurrect "won't fix".
4. **Auto-resolve** — prior `open` issues absent from the fresh analysis become `resolved`.

`carryForwardCachedAnalysis` (`analysisCache.ts`) deliberately routes through this same
`saveAnalysisResult`, so a cached scope's lifecycle is indistinguishable from a fresh one that
happened to find the same things — "which is the truth here, it just didn't need to look."

---

## 8. Two execution modes

### Mode A — single scope (this is what runs every day)

One agent, the 5 stages sequentially, one `save_analysis` call. Every automated audit is exclusively
this mode, because Go's auto-queue never emits `"all"`.

### Mode B — `"all"` fan-out (manual button only, **NOT YET CUT OVER**)

Designed in spec 13, prompts drafted, tools built, prototype validated. Shape:

```
list_changed_scopes(auditId)
  ├─ unchanged → get_cached_scope_analysis(auditId, scope)   [no agent spawned, mark carried_forward:true]
  └─ changed   → parallel(per-type agent per scope)          [barrier — synthesis needs all]
                   prompt: spec/agent/parallel-per-type-agent-prompt.md
                   bounded fetch list; returns candidate findings + chain_hints; NEVER calls save_analysis
                          ↓
              ONE synthesis agent
                   prompt: spec/agent/parallel-synthesis-agent-prompt.md
                   Stages 2–5 happen here; resolves chain_hints; dedups; ONLY caller of save_analysis
```

**Related-types map** (spec 13, finalized 2026-07-15) — 14 of 15 scopes get a dedicated agent
(`inventory` is context-only):

- **Universal context for every agent:** `iam`, `keyvault`, `resourcegroup`, `inventory`
  (iam/keyvault because nearly every Stage-3 chain passes through them regardless of entry point)
- **Networking/edge** — nsg, publicip, cdn + appservice, functions
- **Compute/app** — appservice, appserviceplan, functions + publicip, nsg, cdn, storage, cosmosdb
- **Data** — storage, cosmosdb, acr + appservice, functions
- **AI/ML** — cognitiveservices + appservice, functions
- **Isolated** — vm + nsg, publicip

Fault isolation: a failed per-type agent becomes a `data_gaps` entry; synthesis proceeds with the rest.

---

## 9. Outcomes — what this system has actually produced

### Baseline problem it was built to fix (spec 10 §1, project owner's words)

1. **Fake Criticals** — severity assigned by *category* (security = scary = Critical). "The Critical
   column has cried wolf too often to be trusted."
2. **Too shallow** — 2–4 obvious suggestions per run, coverage random between runs.
3. Genuinely valuable findings (the kind a senior engineer finds after hours of correlation) never appeared.

### Measured result — B7 prototype, 2026-07-15 (spec 13 §"B7 prototype results")

Real historical audit, 11 scopes. Two comparisons were run:

| | Baseline: 11 isolated single-scope analyses | Old-method single-agent `"all"` pass | Prototype: 11 parallel + synthesis |
|---|---|---|---|
| Total findings | 27 | 19 | 19 (from 55 raw candidates) |
| Chain findings | **0** | **1** (cost/reliability) | **5** (identity/security) |
| Severity mix | 4 Crit / 14 Warn / 9 Info | 0 Critical | 1 Crit / 13 Warn / 5 Info |
| Tokens | — | 169,842 | ~985K |
| Wall clock | — | ~3.5 min | ~8.5 min |

**The finding that reframes the cost tradeoff:** the single-agent pass had the *exact same*
IAM/Key Vault/App Service data in one context and still produced **zero** of the 5 identity/security
chains. It flagged the same over-privileged service principal as a plain Warning without ever
connecting it to that principal's direct Key Vault access-policy grant — missing the "one leaked
credential reaches production secrets" chain entirely. So the 5.8× token cost buys **attack paths a
single sweep structurally tends to miss even with equal data access**, not "the same result, faster".

Zero chain findings in the baseline is *expected*, not a flaw — each was a genuinely isolated
single-resource-type request, so a multi-resource path was structurally undetectable.

Severity dropping 4 Critical → 1 reflects Stage 5 refutation working, not a blanket downgrade: one
dev-environment finding was correctly kept low after noticing RBAC (not legacy access policies) was
already in use there.

### Other verified outcomes

- **Cache (spec 14) verified end-to-end 2026-07-14**, 13/13 checks: first-ever audit never cache-hits;
  unchanged scope hits while a changed one doesn't; carry-forward preserves `first_seen_at` and deletes
  the superseded row; the 7-hit ceiling holds exactly at the boundary (7 allowed, 8th forced real).
- **The `data_gaps` feedback loop produced real collector work.** Round 1: 11 of 78 scope-analyses
  reported gaps → spec 11 implemented the extractor-fixable ones. Rounds 2 and 3 followed. One run
  noticed cost data mentioning a Virtual Machine that **no extractor was tracking** — a real blind spot
  that became the `vm` scope.
- **Round-2 self-correction:** the agent had reported "VNet integration missing" as a gap; it had
  always been present on the *site's* properties, not the plan's. Addendum 2 corrects this.

---

## 10. Status board — what is and isn't live

| Capability | Status | Evidence |
|---|---|---|
| MCP server + 6 tools | ✅ live | `mcp/route.ts`, `mcp/tools.ts` |
| Queue + dual insert paths | ✅ live | schema.go, collect.go, audit.ts |
| Event-driven routine firing (3 call sites) | ✅ live | collect.go, createAnalysisRequestController (incl. reuse path), wakeRoutineIfCostUsageUnblocked |
| 5-stage playbook on every scope | ✅ live | `DEEP_RESEARCH_DIRECTIVE` in every branch |
| Severity rubric + evidence requirement | ✅ live | `SEVERITY_RUBRIC` |
| 15 per-type checklists | ✅ live | analysisChecklists.ts |
| Deterministic cost/usage detectors | ✅ live | costInsights.ts, usageInsights.ts |
| `fix_effort` + Quick wins UI | ✅ live | spec 10 Phase 3 |
| Chain findings + `data_gaps` UI | ✅ live | spec 10 §5.4 |
| Per-scope cache + 7-hit ceiling (spec 14, A1–A8) | ✅ live & verified | spec 15 Phase A all `[x]` |
| Cost/usage sequencing behind resource scopes | ✅ live | listPendingAnalysisRequests |
| Consolidated audit-complete email | ✅ live | auditSummaryEmail.ts |
| Parallel fan-out tools (`list_changed_scopes`, `get_cached_scope_analysis`) | ✅ built | tools.ts B6 |
| Parallel per-type + synthesis **prompts** | ✅ drafted | spec/agent/parallel-*.md |
| **Parallel fan-out in production** | ❌ **B8 not done** | spec 15 L189 — the only unchecked box |
| Calibration scenarios rendered into instructions | ❌ 1 of N written | `spec/agent/analysis-scenarios.md` is a template + 1 worked example, **untracked in git** |
| Fault-isolation path | ⚠️ unvalidated | B7 had zero agent failures |
| Cache × fan-out interaction (B5/B6) | ⚠️ unvalidated | no two audits with `scope_hashes` existed at prototype time |
| Chain-finding carry-forward nuance | ⚠️ deferred | see §11.4 |
| Step B live Azure drill-down tool | ❌ deliberately not built | spec 10 §6 — build only for gaps that prove recurrent |

---

## 11. Known gaps and weak points — the enhancement surface

Ranked by my read of leverage-vs-risk.

### 1. The routine's prompt is not in the repo — **highest-risk gap**
The prompt that actually drives the production agent lives only on
`claude.ai/code/routines/trig_016EuQk8v8sTJT8oiYrHbJau`. Everything in this repo is what the prompt
*points at*. Consequences: it is unversioned, unreviewable, undiffable, and a single UI edit can
change production behavior with no trace. Any enhancement to agent behavior should start by getting
that prompt into the repo (even as a copy with a "source of truth is the routine page" caveat) or the
work is untestable.

### 2. No visibility when the pipeline stalls
Spec 8 flagged this and it was never built: if the routine stops (quota exhausted, token expired,
agent erroring), rows pile up in `pending` with **nothing surfaced in the UI**. Concretely:
- `AnalysisPanel`'s poll loop has no attempt cap or timeout — it polls every 7s indefinitely.
- `findAnalysisProgressForAudit` returns a `cached` count and per-scope `cache_hit`, but **no
  component calls `getAnalysisProgress` today** (noted in spec 15 A7).
- Routine-fire failures are `console.warn` only. No alert, no metric, no dead-letter.
- `status='failed'` rows have an `error_message` but no retry mechanism.

### 3. `analysis-scenarios.md` is 1 of N — the measurement gap is the real blocker
The file is designed for dual use: a curated subset rendered into the instruction text as few-shot
calibration, **and** an answer key for a scoring harness (`must_find` / `must_not_find` /
`teaching`). Today there is one worked example (public storage container: prod → Critical, sandbox →
Info) and no harness. **Without this, "did the enhancement improve quality?" is unanswerable** —
every quality claim in §9 is a one-off manual comparison. Also: the file is **untracked in git**.

### 4. Chain findings carry forward unconditionally
Spec 14 says a chain finding should carry forward only if **every** scope it touches is unchanged.
Today's carry-forward copies whatever the prior audit saved for that scope, chain findings included.
Safe-ish now (caching requires an exact hash match) but spec 15 A4 explicitly flags it to revisit
once Phase B's multi-agent chains make it likely to matter. **Enhancing chain detection makes this a
real bug.**

### 5. Duplicated constants and logic across the Go/TS boundary
Kept in sync only by comment cross-reference:
- `CacheStalenessCeiling = 7` (Go) ↔ `CACHE_STALENESS_CEILING = 7` (TS)
- `PreviousAnalyzedScopeHash` + `TrailingCacheHitStreak` (Go) ↔ `checkScopeCacheHit` +
  `trailingCacheHitStreak` (TS)
- `triggerAnalyzerRoutine` exists twice, once per language
- `DEFAULT_ANALYZER_ROUTINE_ID` hardcoded in both

### 6. MCP security surface is minimal
One shared bearer token, internet-reachable, granting full read of every audit's Azure resource data
and write access to findings. No rate limiting, no per-call audit log, no scoping. Also note
`checkBearerToken` uses `===` — not a constant-time comparison.

### 7. `checkScopeCacheHit` is O(scopes) queries
`listChangedScopes` loops scopes and awaits `checkScopeCacheHit` **serially**, and each call runs a
lateral-join query plus a streak query. Fine at 15 scopes; it's a latency floor on every `"all"`
fan-out.

### 8. Two live analysis write paths
`POST /api/audits/[id]/analysis` still calls `runAnalysis` → `analyzeWithLLM` →
`callLLMWithFallback` — the **old synchronous metered/free-model path**, still reachable with
`?provider=&model=` query params. It shares `getScopedAuditData` and `saveAnalysisResult` (good) but
it is exactly the path spec 8 exists to avoid. Decide deliberately whether it's a debug affordance or
dead code.

### 9. Model pin is a generation behind (Chat + legacy sync path only)
`DEFAULT_MODEL = 'claude-sonnet-4-6'` in claude.ts. That ID is still active, but
`claude-sonnet-5` is the current Sonnet. **This does not affect the analyzer** — the routine runs on
whatever model the routine is configured with, and never reads `DEFAULT_MODEL`. It affects Chat and
the legacy sync path above.

### 10. Standing non-collectible backlog (spec 10 §6) — track demand, don't fix blindly
| Item | What it needs |
|---|---|
| Principal-ID → display-name (iam, keyvault) | Microsoft Graph + directory-read consent — **most repeat citations** |
| Sign-in / activity logs | Entra/activity-log read; large volume |
| Key Vault secret metadata (expiry, rotation) | Data-plane vault access — a security decision |
| ACR vulnerability scans | Defender for Cloud — a cost decision |
| App Settings values | `Microsoft.Web/sites/config/list/action`; extractor code already handles it |

---

## 12. Invariants — do not break these

1. **`tools.ts` stays a thin wrapper.** No business logic. It is what guarantees the sync path and the
   MCP path can't drift.
2. **`saveAnalysisResult` is the single write funnel.** Every path — sync LLM, MCP `save_analysis`,
   cache carry-forward — goes through it, so the findings lifecycle is identical everywhere.
3. **`findingKey` is `resource_type|resource_name|category`, never issue text.** LLM wording varies
   every run; changing this key silently breaks age carry-forward, sticky dismissals, and auto-resolve.
4. **One coherent writer per audit+scope.** `findPriorLiveFindings` / `deleteFindingsByScope` assume it.
   This is why synthesis, not the per-type agents, owns the write in Mode B.
5. **Cost & Usage runs on deterministic detectors, no agent.** Out of scope for both spec 13 and 14.
6. **Chat stays on its free-model fallback chain.** Long-standing decision, not an oversight.
7. **`scope_hashes` and other `schema.go` columns only apply when the CLI runs** — never on a dashboard
   deploy. This bit the project on 2026-07-11 with `fix_effort`/`finding_type`. Verify the column
   exists in prod; don't assume.
8. **Routine-fire and email are always best-effort.** A notification or trigger failure must never
   surface as an MCP tool error or fail an audit.
9. **Redact real client data from committed specs.** Spec 13's B7 results are generalized on purpose —
   the real run touched actual client resource names, domains, and principal IDs. Raw prototype output
   stays in a local scratchpad.

---

## 13. File map — where to look

**MCP / agent surface**
- `dashboard/app/api/mcp/route.ts` — transport, auth
- `dashboard/app/api/mcp/tools.ts` — the 6 tools, finding zod schema
- `dashboard/app/api/utils/analyzerRoutine.ts` — routine `/fire` (TS)
- `CLI Engine/cmd/collect.go` L23-73 — routine `/fire` (Go); L340-395 — the auto-queue loop

**Prompt / instruction assembly**
- `dashboard/app/api/utils/claude.ts` — `getScopedAuditData`, `SEVERITY_RUBRIC`,
  `DEEP_RESEARCH_DIRECTIVE`, `PRECOMPUTED_SIGNALS_NOTE`, `buildPrecomputedSignals`,
  `saveAnalysisResult`, `saveFindings`, `findingKey`
- `dashboard/app/api/utils/analysisChecklists.ts` — 15 per-type checklists
- `dashboard/app/api/utils/costInsights.ts` / `usageInsights.ts` — deterministic detectors
- `spec/agent/deep-research-playbook.md` — the 5 stages + 3 addenda
- `spec/agent/parallel-per-type-agent-prompt.md` / `parallel-synthesis-agent-prompt.md` — Mode B
- `spec/agent/analysis-scenarios.md` — calibration + test answer key (1 example so far)

**Queue / cache**
- `dashboard/app/api/models/analysisRequests.ts` — ordering, gating, cache-hit, staleness, progress
- `dashboard/app/api/utils/analysisCache.ts` — carry-forward, `listChangedScopes`, `getCachedScopeAnalysis`
- `dashboard/app/api/controllers/audit.ts` L377-436 — create/poll controllers
- `CLI Engine/internal/db/analysis_requests.go` — Go twin
- `CLI Engine/internal/db/schema.go` L177-200 — table + `cache_hit`

**Read path**
- `dashboard/app/components/AnalysisPanel.tsx` — 7s poll, cache badges, chain headline card, Quick wins
- `dashboard/app/api/models/findings.ts` — `insertFinding`, `findSubscriptionFindingHistory`, lifecycle queries

**Specs — for the *why***
- 08 MCP + orchestrator (architecture + constraints) · 09 quality backlog (superseded by 10) ·
  10 deep research strategy · 11 extractor enrichment from data_gaps · 12 remaining gaps ·
  13 parallel agents (+ B7 results) · 14 per-scope cache · 15 execution plan and status
- `spec/analyze-method-explained.md` — plain-language old-vs-new, good for non-technical stakeholders

**Env vars the pipeline depends on**
`MCP_BEARER_TOKEN` (MCP auth) · `ROUTINE_TRIGGER_TOKEN` (routine `/fire`, per-routine token, shown
once at generation) · `ANALYZER_ROUTINE_ID` (optional override)

---

## 14. If I were enhancing this, in order

1. **Get the routine prompt into the repo.** Nothing else is safely testable until agent behavior is
   versioned.
2. **Build the scoring harness on `analysis-scenarios.md`, and commit the file.** Then every later
   change has a number attached instead of an anecdote. Highest-value scenarios per the file itself:
   calibration traps (looks Critical, should be downgraded) and chains.
3. **Add stall visibility** — surface "pending longer than expected", wire the already-built
   `AnalysisProgress`, cap the poll loop, alert on repeated routine-fire failure.
4. **Then cut over B8** — with 1–3 in place you can actually tell whether the fan-out helps in
   production, instead of relying on one prototype run.
5. **Fix the chain carry-forward nuance before, not after,** chain detection gets better.
