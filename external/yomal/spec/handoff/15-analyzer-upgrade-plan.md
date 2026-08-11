# Spec 15 — Analyzer upgrade: implementation plan & task list

> Status: **plan — not started.** This is the "what we do and how we do it" companion to two idea
> specs: `14-analysis-cache.md` (per-scope analysis cache — build FIRST) and
> `13-parallel-resource-agents.md` (12 parallel per-resource-type agents + synthesis — build
> SECOND, consumes the cache's change signal). Read those for the reasoning; this doc is the
> execution order.

## What we are doing (one paragraph)

Two upgrades to the AI analysis pipeline, in order. **Phase A (cache):** hash each scope's config
data at audit-save time; on an analysis request, skip any scope whose hash matches the last
analyzed audit and carry its findings forward through the existing lifecycle — so unchanged days
cost zero agent time. **Phase B (parallel agents):** for the scopes that DID change, replace the
single sequential playbook run with one agent per resource type running in parallel (each also
given its related types' data), followed by a single synthesis agent that does the cross-resource
correlation/chaining/severity work and is the only writer via `save_analysis`. Cost & Usage page is
untouched throughout — it runs on the deterministic detectors, no agent involved.

## How we do it

### Phase A — per-scope analysis cache (spec 14)

Order of operations matters: schema → CLI hashing → dashboard comparison → carry-forward → ceiling.
Each step is independently shippable and inert until the next one uses it.

- [x] **A1. Schema**: add `scope_hashes JSONB` (scope → hash) to the audits table in
      `CLI Engine/internal/db/schema.go`. Run the CLI (or one-off `db.ApplySchema`) against prod
      and **verify the column exists** — do not assume a dashboard deploy applied it (2026-07-11
      gotcha). Done 2026-07-14: column added and verified present on the production Supabase DB.
- [x] **A2. CLI hashing**: at audit-save time, canonically marshal each scope's cleaned config JSON
      and store a SHA-256 per scope into `scope_hashes`. Unit test: same data → same hash across
      runs; key-order changes → same hash (canonical marshal). Done 2026-07-14:
      `extractors.ScopeHash` + wiring in `collect.go`/`db.CompleteAudit`, 3 unit tests passing.
- [x] **A3. Change detection**: in the dashboard analysis-request path, compare the new audit's
      `scope_hashes` to the most recent analyzed audit for the same subscription. Decide here (open
      question in spec 14): mark cached scopes on the `analysis_requests` row up front
      (recommended — keeps the agent prompt simple) vs. a new MCP tool the agent queries. Done
      2026-07-14: added `analysis_requests.cache_hit BOOLEAN` (schema + applied to prod). Go:
      `db.PreviousAnalyzedScopeHash` + `db.ScopeToQueue` wired into `collect.go`'s auto-queue loop
      (the scheduled/daily path). TS: `checkScopeCacheHit`/`insertAnalysisRequest(..., cacheHit)`
      wired into `createAnalysisRequestController` (the manual Analyze-button path) — both paths
      use the same "analyzed" definition: most recent PRIOR audit of the same subscription with a
      `status='done'` request for that exact scope. cost/usage/"all" never cache-check (no
      scope_hashes entry), matching spec 14. **Note:** this only marks the flag — nothing yet
      consumes `cache_hit` to actually skip agent work or carry findings forward; that's A4.
- [x] **A4. Carry-forward**: extend the findings lifecycle in `claude.ts` so skipped scopes'
      findings re-link to the new audit with age/first-seen preserved and "open for N audits"
      incremented. Chain findings carry forward only if every scope they touch is unchanged. Done
      2026-07-14: new `utils/analysisCache.ts` (`carryForwardCachedAnalysis` — reuses the existing
      `saveAnalysisResult`/`saveFindings` lifecycle unchanged, so age/sticky-dismiss/auto-resolve
      behave identically to a fresh analysis; `resolveCachedAnalysisRequests` — batch-resolves all
      pending `cache_hit` rows). New `models/audit.ts:findPreviousAnalyzedAuditId` and
      `models/analysisRequests.ts:findPendingCacheHitRequests` support it. Wired into the MCP
      `list_pending_requests` tool (resolves cache hits before the agent ever sees them — covers
      the scheduled/Go-queued path) AND into `createAnalysisRequestController` (resolves
      synchronously right after insert — instant result on a manual cached click, no agent round
      trip). Best-effort/fail-open: if carry-forward can't find a usable prior analysis, the
      request is left pending and the agent processes it normally. Build/typecheck/lint clean.
      **Not yet handled — deferred to A4-followup or folded into spec 13:** the "chain findings only
      carry forward if every scope they touch is unchanged" nuance from spec 14 — today's carry-
      forward reuses whatever findings the prior audit saved for that scope, including any chain
      finding that touched multiple scopes; this is safe today since caching is opt-in per exact
      hash match, but revisit once Phase B's multi-agent chains make this more likely to matter.
- [x] **A5. Staleness ceiling**: force real re-analysis of a scope after 7 consecutive cache hits;
      reset the counter on any real run. Done 2026-07-14: computed dynamically rather than stored
      (`db.CacheStalenessCeiling = 7` in Go, `CACHE_STALENESS_CEILING = 7` in
      `models/analysisRequests.ts`, kept in sync by comment cross-reference). Both
      `TrailingCacheHitStreak`/`trailingCacheHitStreak` count consecutive `cache_hit=true` requests
      going backward from the current audit for that scope, stopping at the first real analysis;
      `cacheHit` is only set true when the hash matches AND the streak is still under the ceiling —
      the "reset" happens naturally since a real analysis breaks the streak the query counts.
- [x] **A6. Playbook + routine prompt update**: tell the agent cached scopes are already handled —
      analyze only the scopes the request marks as changed; history calls still see carried-forward
      findings. Done 2026-07-14: added a note to `spec/agent/deep-research-playbook.md`'s
      Preconditions explaining that `list_pending_requests` silently resolves cache hits before
      returning, so seeing fewer pending scopes than the resource-type count is expected — the
      agent should only reason about scopes it's actually handed, not infer/re-derive ones it
      wasn't asked about. No routine-prompt change needed beyond this — cached scopes never reach
      the agent at all, so there was nothing else for the agent-facing instructions to say.
- [x] **A7. UI touch (small)**: analysis page should show which scopes were served from cache vs.
      freshly analyzed (a badge/note), so a "fast" result doesn't read as a broken/shallow one. Done
      2026-07-14: `cacheHit`/`cache_hit` threaded through `createAnalysisRequestController`/
      `getAnalysisRequestController` → `api.ts` → `AnalysisPanel.tsx`, which now shows a "No changes
      since last audit" badge (distinct from the pre-existing "Cached · ..." badge, which means
      something unrelated — an analysis result already exists to view, not that it was cache-served
      today). Also extended `findAnalysisProgressForAudit`/`AnalysisProgress` with a `cached` count
      and per-scope `cache_hit` for future use (not yet consumed by any component — no existing UI
      calls `getAnalysisProgress` today). **Bug fix caught along the way:** A4's synchronous cache
      resolution meant `requestAnalysis` could now return `status: 'done'` on the very first
      response, but `AnalysisPanel`'s poll loop only ever rendered a result found *inside* the
      `while (current === 'pending')` loop — an immediate 'done' would have silently never rendered
      anything. Fixed by fetching/applying the result once before entering the loop.
- [x] **A8. Verify end-to-end**: two audits on identical data → second one skips all scopes,
      findings show age 2; then change one NSG rule → only `nsg` re-analyzes. Done 2026-07-14: ran a
      throwaway TS script (with explicit user approval, since it wrote to production Postgres)
      against a synthetic, clearly-fake `subscription_id` (`test-spec14-verify-DO-NOT-USE`),
      exercising the REAL `checkScopeCacheHit`/`carryForwardCachedAnalysis` functions rather than
      re-derived SQL. 13/13 checks passed: (1) a scope's first-ever audit never cache-hits (no
      prior analyzed audit exists), (2) an unchanged scope (`nsg`) cache-hits on the next audit
      while a changed scope (`storage`, different hash) does not, (3) carry-forward actually copies
      the finding to the new audit with `first_seen_at` preserved from the original (age carried
      forward correctly) and deletes the superseded original row (no duplication), (4) the 7-hit
      staleness ceiling holds exactly at the boundary — 7 consecutive cache hits allowed, the 8th
      forced back to a real analysis. All test rows were deleted in a `finally` block regardless of
      outcome, and a follow-up read-only query confirmed zero rows remain under the fake
      subscription. The throwaway script itself was deleted after the run (not committed).

### Phase B — parallel per-resource-type agents (spec 13)

Prototype against a past audit's data before touching the production routine.

- [x] **B1. Decide the "related types" map**: which extra scopes each per-type agent receives
      (draft: networking — NSG+PublicIP+CDN; identity — IAM+KeyVault; app — AppService+
      AppServicePlan+Functions; data — Storage+CosmosDB; finalize before prompting). Done
      2026-07-15 — finalized in `spec/handoff/13-parallel-resource-agents.md`. 14 of 15 scopes get a
      dedicated agent (every one with an `analysisChecklists.ts` entry); `inventory` stays
      context-only. `iam`/`keyvault`/`resourcegroup`/`inventory` are UNIVERSAL context for every
      agent (pulled out of any single cluster since Stage 3 chains almost always pass through
      iam/keyvault regardless of starting resource type). Four clusters on top of universal:
      networking/edge (nsg, publicip, cdn), compute/app (appservice, appserviceplan, functions),
      data (storage, cosmosdb, acr), AI/ML (cognitiveservices); `vm` gets nsg+publicip only
      (currently empty subscription, kept for completeness).
- [x] **B2. Decide when it triggers**: full fan-out only for `"all"`/multi-scope requests; a
      single-resource-type request stays a single agent (it doesn't need 12). Done 2026-07-15 —
      decided in spec 13: ONLY `scope === "all"` triggers the fan-out. Confirmed from the actual
      code that Go's auto-queue (the daily/scheduled path) never queues `"all"` — only individual
      resource-type/cost/usage scopes — so `"all"` only ever comes from the dashboard's manual
      "analyze everything" button (already gated behind a confirmation dialog per `runAnalysis`'s
      own comment). This means Phase B needs **no new Postgres schema or analysis_requests
      plumbing**: the top-level agent that claims the `"all"` request uses the `Workflow` tool
      itself internally (14 parallel per-type agents → synthesis) and still calls `save_analysis`
      once at the end, matching today's one-call-per-request contract exactly — so B implementation
      is mostly a playbook/prompt change (B3/B4/B9), not new infra. Noted for B5: whether the
      `"all"` fan-out should also check each sub-scope's cache_hit status (spec 14) and skip/carry-
      forward accordingly — deferred as an orchestration-layer decision, not decided here.
- [x] **B3. Per-type agent prompt**: scoped playbook Stage 1 + that type's `analysisChecklists.ts`
      entry + related-type data; returns **structured candidate findings** (schema-enforced), never
      calls `save_analysis`. Done 2026-07-15 — drafted in full at
      `spec/agent/parallel-per-type-agent-prompt.md`. Bounds each agent to fetching only its own
      scope + its exact related-scopes list (no open-ended fetching, unlike the main playbook's
      single-agent mode) so 14 agents don't each converge on refetching all 14 scopes. Still
      attempts full chain-building when the agent's own related scopes (iam/keyvault are universal)
      are enough to complete it, and emits a `chain_hints` array for leads it can see the start of
      but not the destination — synthesis picks those up. Severity is explicitly provisional, not
      final; `save_analysis` is never called by these agents.
- [x] **B4. Synthesis agent prompt**: consumes all candidate-finding sets; runs Stages 2–5
      (correlate, chain across types, judge with `get_audit_history`, refute every Critical),
      dedups overlaps, and is the **only** caller of `save_analysis`. Done 2026-07-15 — drafted in
      full at `spec/agent/parallel-synthesis-agent-prompt.md`. Resolves `chain_hints` from B3's
      agents by checking whether another agent's findings (or a fresh `get_audit_data` call)
      completes the lead; keeps direct MCP tool access itself rather than being limited to the 14
      agents' text outputs; treats cross-agent dedup (same `resource_type|resource_name|category`)
      as its most load-bearing job, not an afterthought, since overlapping universal/cluster context
      means the same real issue can legitimately surface from more than one agent's angle.
- [x] **B5. Orchestration**: routine executes fan-out with a barrier (parallel per-type agents →
      wait for all → synthesis). Spawn agents only for scopes Phase A marked as changed. A failed
      per-type agent is logged and synthesis proceeds with the rest (fault isolation). Done
      2026-07-15 — full pseudo-code + decisions in spec 13 §Orchestration. Closes the B2-flagged gap
      ("all" requests never interacted with the cache): a fresh per-scope hash check runs at the
      start of every `"all"` fan-out (via a new `list_changed_scopes` tool, B6), cached scopes are
      pulled in directly via `get_cached_scope_analysis` (B6) with NO agent spawned for them and
      marked `carried_forward: true` so synthesis doesn't waste refutation effort re-checking
      already-refuted findings, changed scopes get a real per-type agent in `parallel()`, and a
      failed per-type agent becomes a `data_gaps` entry instead of failing the whole run.
- [x] **B6. MCP additions**: a way for a per-type agent to fetch its related scopes' data without
      knowing the map itself — or bake the related data into the request payload; pick whichever B3
      makes simpler. Done 2026-07-15 — two parts: (1) no new tool needed for per-type agents to
      fetch related-scope data — B3 already decided they just call the existing `get_audit_data`
      once per scope in their fixed related-scopes list, same tool every other agent already uses;
      (2) implemented the two NEW tools B5's orchestration design actually required —
      `list_changed_scopes(auditId)` and `get_cached_scope_analysis(auditId, scope)` — registered in
      `mcp/tools.ts`, backed by `utils/analysisCache.ts:listChangedScopes`/`getCachedScopeAnalysis`
      (new) + `models/audit.ts:findAuditScopeHashes` (new). `listChangedScopes` reuses the existing
      `checkScopeCacheHit` per scope — same definition a standalone single-scope request uses, so
      the two paths can never disagree about what counts as changed. Typecheck/build/lint clean.
- [x] **B7. Prototype run**: execute the full fan-out + synthesis against one historical audit
      offline; compare finding quality/dedup against that audit's real saved analysis before
      switching the production routine over. Done 2026-07-15 — full results in spec 13
      §"B7 prototype results". Headline: existing baseline (11 isolated single-scope analyses) had
      27 findings and **zero** chain findings (structurally impossible in isolation); the prototype
      produced 19 final findings after dedup (from 55 raw per-type candidates) including **5**
      evidence-backed cross-resource chain findings, confirming spec 13's core value proposition.
      Severity mix showed real Stage 5 refutation (4 baseline Critical-equivalent vs. 1 in
      prototype, not a blanket downgrade — one dev-environment finding was correctly kept low after
      noticing RBAC vs. legacy access policies). Cost: ~985K subagent tokens, ~8.5 min wall clock,
      zero agent failures (fault-isolation path still unvalidated). Cache-integration (B5/B6) not
      exercised — no two audits exist yet with `scope_hashes` to compare. Verdict: proceed to B8.
- [ ] **B8. Cut over the routine prompt** and watch the first scheduled run live
      (`https://claude.ai/code/routines/trig_016EuQk8v8sTJT8oiYrHbJau`).
- [x] **B9. Update `spec/agent/deep-research-playbook.md`**: split into per-type-agent
      instructions and synthesis-agent instructions (Stages 2–5 move to synthesis). Done
      2026-07-15 — added a note right after the intro: the existing 5-stage flow (Preconditions
      through Stage 5) is unchanged and still followed directly for any single-scope/cost/usage
      request; for `scope === "all"` specifically, the top-level agent instead calls
      `list_changed_scopes`/`get_cached_scope_analysis` for unchanged scopes, spawns per-type agents
      (B3 prompt) for changed ones, then runs one synthesis pass (B4 prompt) that is the only caller
      of `save_analysis`. No stage content was rewritten — only WHO executes which stages changed
      for the `"all"` case.

## Acceptance criteria

- Unchanged audit day: analysis request completes with **zero** agent-analyzed scopes; findings
  carried forward with correct ages; UI marks scopes as cached.
- Partially changed day: only changed scopes' agents run; synthesis still catches a cross-scope
  chain involving one changed + one cached scope (the chain rule from spec 14 open-questions).
- Failure of one per-type agent does not fail the run; the gap is recorded in `data_gaps`.
- No duplicate findings after synthesis (existing dedup key holds: `resource_type+resource_name+
  category`).
- A false-Critical rate no worse than the current single-agent baseline (Stage 5 refutation lives
  in synthesis and is not skipped).

## Explicitly out of scope

- Cost & Usage page and the deterministic detectors (`costInsights.ts`/`usageInsights.ts`) —
  unchanged by both phases.
- Chat — stays on free models, unchanged (long-standing decision).
- Per-resource (finer than per-scope) hashing — revisit only if scope-level hit rates disappoint.
