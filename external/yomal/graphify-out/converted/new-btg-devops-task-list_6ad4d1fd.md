<!-- converted from new-btg-devops-task-list.xlsx -->

## Sheet: Task List
| btg-devops — Project Task List |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Team: Dev A (CLI / Backend)  ·  Dev B (Dashboard / Frontend)  ·  Last updated: 2026-07-20  ·  MCP Server reinstated (Spec 8) — Analyze now runs via MCP server + scheduled Claude Code agent instead of a direct Anthropic API call |  |  |  |  |  |  |  |  |  |
| # | Phase | Task Name | Description | Assignee | Depends On | Est. Time | Status | Priority | Notes |
|   Engineering Quality · v0.13.0 |  |  |  |  |  |  |  |  |  |
| 1 | Phase 1 · v0.13.0 | Unit Tests | 12 test files in tests/ — one per analyzer module. Table-driven pattern, no real Azure calls. | Dev A | — | 3 days | ✅ Done | High | tests/security_analyzers/, tests/usage_analyzers/ |
| 2 | Phase 1 · v0.13.0 | CI Pipeline | GitHub Actions workflow — build → test → lint on every push and PR. Blocks merge on failure. | Dev A | Task 1 | 1 day | ✅ Done | High | Moved to repo-root .github/workflows/ci.yml (commit 4273957/11db737) |
| 3 | Phase 1 · v0.13.0 | CHANGELOG.md | Version history using Keep a Changelog format. | Both | Task 2 | 0.5 day | ✅ Done | Medium | Conventional commits format |
| 4 | Phase 1 · v0.13.0 | CONTRIBUTING.md | Build, test, lint, PR checklist, and release process guide for contributors. | Both | Task 3 | 0.5 day | ✅ Done | Medium | Covers Windows + Mac/Linux |
| 5 | Phase 1 · v0.13.0 | Docs Verification | Confirm all 12 module docs exist in docs/ with valid links and severity rules matching the code. | Both | Task 4 | 1 day | ✅ Done | Medium | Fix docs only — no code changes |
| 6 | Phase 1 · v0.13.0 | analyze all command | Runs all 12 analyzers in one command. Supports --output json and --resource-group flags. | Dev A | Task 5 | 2 days | ✅ Done | High | cmd/analyze.go, cmd/all.go |
| 7 | Phase 1 · v0.13.0 | Release Tag v0.13.0 | Tag and push v0.13.0 to trigger cross-platform binary release. | Both | Task 6 | 0.5 day | ✅ Done | High | git tag v0.13.0 && git push |
|   Core Pipeline + Dashboard · v0.14.0 |  |  |  |  |  |  |  |  |  |
| 8 | Phase 2 · v0.14.0 | analyze cost command | Queries Azure Cost Management API. Shows total spend, cost by service, top resources. | Dev A | Task 7 | 2 days | ✅ Done | High | cmd/costanalysis.go (legacy, kept as-is per Spec 7) |
| 9 | Phase 2 · v0.14.0 | Build extractors | internal/extractors/ — one file per resource. Cleans raw Azure JSON (200+ fields) into 8-10 key fields. | Dev A | Task 8 | 3 days | ✅ Done | High | 15 files incl. cost.go/usage.go added later (Spec 7) |
| 10 | Phase 2 · v0.14.0 | Database schema | Design and create database tables to store clean audit data. Every audit run = new record. | Dev A | Task 9 | 2 days | ✅ Done | High | Postgres, not SQLite — 10 tables in internal/db/schema.go |
| 11 | Phase 2 · v0.14.0 | CLI save pipeline | Wire collect to: fetch raw → clean via extractors → save to database. CLI = data collector only. | Dev A | Task 10 | 2 days | ✅ Done | High | cmd/collect.go; also auto-queues analysis_requests (a6df1ad) |
| 12 | Phase 2 · v0.14.0 | Scheduled trigger | GitHub Actions cron job to run btg-devops collect automatically on a schedule. | Dev A | Task 11 | 1 day | ✅ Done | Medium | .github/workflows/scheduled-audit.yml — daily 08:00 UTC + manual dispatch |
| 13 | Phase 2 · v0.14.0 | HTTP API Server | REST endpoints to read saved audits from database. Used by dashboard to list and fetch audit records. | Dev A | Task 10 | 3 days | ✅ Done | High | DEVIATION: built as Next.js API routes (app/api/*) querying Postgres directly, not a separate Go cmd/server.go |
| 14 | Phase 2 · v0.14.0 | Dashboard Scaffold | Next.js 14+ project with TypeScript, Tailwind CSS, and Recharts. Folder: dashboard/ | Dev B | — | 2 days | ✅ Done | High | Next.js 16 / React 19 in practice (Spec 1) |
| 15 | Phase 2 · v0.14.0 | Audit history view | Dashboard page listing all saved audits with summary counts. | Dev B | Task 13 | 2 days | ✅ Done | High | app/audits/page.tsx, now with live per-resource analysis progress |
| 16 | Phase 2 · v0.14.0 | Method 1 — Analyze button | User selects an audit and clicks Analyze. Results shown as cards + table. | Dev B | Task 14 | 3 days | ✅ Done | High | REVISED: now async — creates a pending analysis_requests row, frontend polls every 7s (AnalysisPanel.tsx) instead of waiting on a synchronous LLM call |
| 17 | Phase 2 · v0.14.0 | Method 2 — Chat interface | User types questions in chat; backend fetches relevant audit(s) and responds. | Dev B | Task 14 | 4 days | ✅ Done | High | Threaded chat (chat_threads table, ChatDock.tsx) — defaults to free model (Gemini), unaffected by the MCP/Analyze changes per Spec 8 |
| 18 | Phase 2 · v0.14.0 | Deploy to Vercel | Connect dashboard repo to Vercel. Verify Analyze + Chat on live URL. | Dev B | Tasks 16+17 | 1 day | ✅ Done | High | dashboard/.vercel/project.json confirms live Vercel project |
|   MCP Orchestrator · Spec 8 (replaces v0.14.0's direct-API plan) |  |  |  |  |  |  |  |  |  |
| 19 | Phase 2.5 · Spec 8 | analysis_requests table | Queue table: id, audit_id, scope, status (pending/done/failed), requested_at, completed_at. | Dev A | Task 10 | 0.5 day | ✅ Done | High | internal/db/schema.go + internal/db/analysis_requests.go |
| 20 | Phase 2.5 · Spec 8 | MCP server (3 tools) | list_pending_requests / get_audit_data / save_analysis, thin wrappers over existing model functions. | Dev B | Task 19 | 2 days | ✅ Done | High | dashboard/app/api/mcp/route.ts + tools.ts — stateless, runs on Vercel |
| 21 | Phase 2.5 · Spec 8 | MCP bearer-token auth | Separate secret from dashboard JWT auth; MCP server is reachable from Claude's cloud infra. | Dev B | Task 20 | 0.5 day | ✅ Done | High | MCP_BEARER_TOKEN env var, checked in route.ts |
| 22 | Phase 2.5 · Spec 8 | Frontend queue + poll wiring | Analyze button posts to analysis-request endpoint instead of calling an LLM directly; polls for status. | Dev B | Task 19 | 1 day | ✅ Done | High | AnalysisPanel.tsx, analysis-request/[requestId]/route.ts |
| 23 | Phase 2.5 · Spec 8 | Scheduled Claude Code cloud agent | Agent polls list_pending_requests, calls get_audit_data, reasons, calls save_analysis. | TBD | Tasks 20-22 | 1 day | 🔲 Pending | High | NOT CONFIRMED IN REPO — no schedule definition found (only a runtime .claude/scheduled_tasks.lock artifact). This is the missing link: without it, analysis_requests rows never get consumed. Set up via the `schedule` skill. |
| 24 | Phase 2.5 · Spec 8 | End-to-end MCP test | Verify a real audit flows: click Analyze → queued → agent picks up → result appears in UI. | Both | Task 23 | 0.5 day | ⚠ Blocked | High | Blocked on Task 24 existing at all |
|   Platform Features · built beyond original v0.14.0 plan |  |  |  |  |  |  |  |  |  |
| 25 | Phase 2.6 · Platform | Cost/Usage raw extractors | internal/extractors/cost.go + usage.go — raw-only, no interpretive waste scoring in Go. | Dev A | Task 9 | 2 days | ✅ Done | Medium | Spec 7 — replaces reliance on legacy calcWasteScore() |
| 26 | Phase 2.6 · Platform | Cost & Usage dashboard page | KPI cards, cost trend/top-services charts, per-resource usage breakdown, embedded Analyze + Chat. | Dev B | Task 25 | 3 days | ✅ Done | Medium | app/cost-usage/page.tsx (commit 2f933c4) |
| 27 | Phase 2.6 · Platform | Multi-provider LLM fallback | Claude (Anthropic SDK) + Gemini + OpenRouter, with automatic fallback chain on 429/5xx. | Dev B | Task 14 | 2 days | ✅ Done | Medium | app/api/utils/llm.ts, app/lib/modelCatalog.ts |
| 28 | Phase 2.6 · Platform | Chat threads | Multiple named conversations per audit instead of one flat message log. | Dev B | Task 17 | 1 day | ✅ Done | Medium | chat_threads table + backfill migration, ChatDock.tsx |
| 29 | Phase 2.6 · Platform | Subscriptions admin CRUD | Admin-only management of Azure subscription service-principal credentials. | Dev B | Task 14 | 2 days | ✅ Done | Medium | Spec 4 — app/subscriptions, client secret write-only |
| 30 | Phase 2.6 · Platform | Users admin CRUD | Admin-only management of user accounts and roles. | Dev B | Task 29 | 1.5 days | ✅ Done | Medium | Spec 5 — app/users |
| 31 | Phase 2.6 · Platform | Dashboard enhancements | Skeleton loaders, trend charts, Top Issues panel, audit comparison view. | Dev B | Tasks 15,16 | 3 days | ✅ Done | Medium | Spec 6 — subsumes old Future item F4 (audit comparison) |
| 32 | Phase 2.6 · Platform | Manual Run Audit trigger | Admin-only button dispatches the scheduled-audit GitHub workflow on demand, with live progress. | Dev B | Task 12 | 2 days | ✅ Done | Medium | commit d2c561d + fix 38f7aaa |
| 33 | Phase 2.6 · Platform | Role-based notification emails | Per-role opt-in for audit alert emails (admin enabled by default). | Dev A | Task 10 | 1 day | ✅ Done | Low | notification_role_settings table, Gmail creds in GH Actions secrets |
|   Analyzer Cache + Parallel Agents · Spec 13/14/15 |  |  |  |  |  |  |  |  |  |
| 34 | Phase 4 · Spec 13/14/15 | Schema: scope_hashes + cache_hit | Add scope_hashes JSONB (audits) and cache_hit BOOLEAN (analysis_requests), applied to prod. | Dev A | Task 10 | 0.5 day | ✅ Done | High | spec/handoff/14-analysis-cache.md |
| 35 | Phase 4 · Spec 13/14/15 | CLI per-scope hashing | extractors.ScopeHash computes a SHA-256 per resource-type scope at collect time; unit tested. | Dev A | Task 34 | 1 day | ✅ Done | High | internal/extractors/scopehash.go |
| 36 | Phase 4 · Spec 13/14/15 | Change detection (cache_hit) | Go auto-queue + dashboard manual-Analyze path both compare hash vs. last analyzed audit and mark cache_hit. | Both | Task 35 | 1.5 days | ✅ Done | High | db.PreviousAnalyzedScopeHash, checkScopeCacheHit |
| 37 | Phase 4 · Spec 13/14/15 | Carry-forward findings | Cache hits reuse saveAnalysisResult/saveFindings unchanged so age/dismiss/auto-resolve behave as a fresh pass. | Dev B | Task 36 | 1 day | ✅ Done | High | utils/analysisCache.ts |
| 38 | Phase 4 · Spec 13/14/15 | Staleness ceiling | Force a real re-analysis after 7 consecutive cache hits per scope, computed dynamically. | Both | Task 36 | 1 day | ✅ Done | Medium | db.CacheStalenessCeiling, TrailingCacheHitStreak |
| 39 | Phase 4 · Spec 13/14/15 | Playbook cache note | Tell the agent list_pending_requests silently resolves cache hits before it ever sees them. | Dev B | Task 37 | 0.5 day | ✅ Done | Medium | spec/agent/deep-research-playbook.md |
| 40 | Phase 4 · Spec 13/14/15 | UI cache badge | "No changes since last audit" badge on the analysis page for cache-served scopes. | Dev B | Task 37 | 1 day | ✅ Done | Medium | AnalysisPanel.tsx |
| 41 | Phase 4 · Spec 13/14/15 | Verify cache end-to-end | Identical audits skip all scopes; one changed NSG rule re-analyzes only that scope. | Both | Tasks 38,39,40 | 0.5 day | ✅ Done | High | Verified against a synthetic test subscription |
| 42 | Phase 4 · Spec 13/14/15 | Related-types map (spec 13) | Universal iam/keyvault/resourcegroup/inventory context + 4 clusters for the 14 per-type agents. | Dev B | Task 41 | 1 day | ✅ Done | Medium | spec/handoff/13-parallel-resource-agents.md |
| 43 | Phase 4 · Spec 13/14/15 | Fan-out trigger condition | Only scope=="all" triggers the parallel fan-out; single-scope requests unchanged. | Dev B | Task 42 | 0.5 day | ✅ Done | Medium | No new analysis_requests plumbing needed |
| 44 | Phase 4 · Spec 13/14/15 | Per-type agent prompt | Bounded fetch list, attempts chains when universal context suffices, emits chain_hints. | Dev B | Task 42 | 1 day | ✅ Done | Medium | spec/agent/parallel-per-type-agent-prompt.md |
| 45 | Phase 4 · Spec 13/14/15 | Synthesis agent prompt | Resolves chain_hints, dedups across agents, sole caller of save_analysis. | Dev B | Task 44 | 1 day | ✅ Done | Medium | spec/agent/parallel-synthesis-agent-prompt.md |
| 46 | Phase 4 · Spec 13/14/15 | Orchestration design | parallel() fan-out + barrier + synthesis; cached scopes skip agents entirely. | Dev B | Tasks 43,44,45 | 1 day | ✅ Done | Medium | spec 13 §Orchestration |
| 47 | Phase 4 · Spec 13/14/15 | MCP tools: list_changed_scopes / get_cached_scope_analysis | New MCP tools so the "all" fan-out can skip agents for unchanged scopes. | Dev B | Task 46 | 1.5 days | ✅ Done | Medium | mcp/tools.ts, utils/analysisCache.ts |
| 48 | Phase 4 · Spec 13/14/15 | Prototype run vs. historical audit | 11 agents + synthesis found 5 cross-resource chains the old single-agent method missed entirely. | Both | Task 47 | 2 days | ✅ Done | High | Results (redacted) in spec 13 |
| 49 | Phase 4 · Spec 13/14/15 | Cutover: commit + push to production | Committed and pushed all Phase A/B work; auto-deploys dashboard + new MCP tools. | Both | Task 48 | 0.5 day | ✅ Done | High | 2 commits, production branch |
| 50 | Phase 4 · Spec 13/14/15 | Playbook split (per-type vs synthesis) | Playbook branches: unchanged 5-stage flow for normal scopes, new fan-out steps for "all". | Dev B | Task 48 | 0.5 day | ✅ Done | Medium | spec/agent/deep-research-playbook.md |
| 51 | Phase 5 · Agent Enhancements | Adversarial verification pass for Critical findings | Dedicated critic sub-agent attempts to actively refute each Critical/High finding before save_analysis is called; a finding is killed if the critic disproves it. Reduces false positives beyond the playbook's existing self-verify step (Stage 5). | Dev B | Task 50 | 1.5 days | 🔲 Pending | High | Extends Stage 5 (Verify) of deep-research-playbook.md; needs a new critic-agent prompt + wiring in the routine before save_analysis |
|   Future Scope |  |  |  |  |  |  |  |  |  |
| F1 | Phase 3 · Future | Slack Integration | Post audit findings and critical alerts to DevOps team channel automatically. | TBD | Phase 2 | 3 days | ⏳ Future | Low | Requires stable audit rules |
| F2 | Phase 3 · Future | Drift Detection | btg-devops drift — detect differences between IaC and live Azure configuration. | Dev A | Phase 2 | 5 days | ⏳ Future | Low | Requires IaC inventory |
| F3 | Phase 3 · Future | Runbook Library | Searchable operational runbooks inside the dashboard. | Dev B | Phase 2 | 4 days | ⏳ Future | Low | Requires runbook authoring process |
| F4 | Phase 3 · Future | Cross-region detector | Specific Claude prompt focus to detect resources in different regions calling each other. | Dev A | Task 25 | 2 days | ⏳ Future | Medium | Catches cases like the $200/month cross-region example |
|   Architecture History |  |  |  |  |  |  |  |  |  |
| H1 | History | MCP Server (cmd/mcp.go) | Original Go-based MCP server concept. | — | — | — | ❌ Removed | — | Removed 2026-06-30 in favor of direct Claude API; REINSTATED 2026-07 as dashboard/app/api/mcp per Spec 8, for a different purpose (Claude Code subscription orchestration, not a Go binary) |
## Sheet: Summary
| btg-devops — Progress Summary |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- |
| Phase | Total Tasks | Done | Pending/Blocked | Future | Est. Total Time | Progress |
| Phase 1 · v0.13.0 | 7 | 7 | 0 | 0 | 8.5 days | 100% |
| Phase 2 · v0.14.0 | 11 | 11 | 0 | 0 | 25 days | 100% |
| Phase 2.5 · Spec 8 (MCP Orchestrator) | 6 | 4 | 2 | 0 | 5.5 days | 67% |
| Phase 2.6 · Platform Features | 9 | 9 | 0 | 0 | 17.5 days | 100% |
| Phase 4 · Spec 13/14/15 | 17 | 17 | 0 | 0 | 16 days | 100% |
| Phase 5 · Agent Enhancements | 1 | 0 | 1 | 0 | 1.5 days | 0% |
| Phase 3 · Future | 4 | 0 | 0 | 4 | 14 days | 0% |
| TOTAL | 55 | 48 | 3 | 4 | 88 days | 87% |
| Status Legend |  |  |  |  |  |  |
| ✅ Done | 🔲 Pending | ⚠ Blocked | ⏳ Future | ❌ Removed |  |  |
| Architecture Update (2026-07-09): The 2026-06-30 decision to remove the MCP server was reversed. Per spec/handoff/08-mcp-claude-orchestrator.md, Analyze now runs via an MCP server (dashboard/app/api/mcp) + a scheduled Claude Code cloud agent, using the existing Claude Pro/Max subscription quota instead of a metered API key (not budgeted) or free-tier models (unreliable — a free OpenRouter model produced garbled JSON in a prior production incident). Chat is unaffected and still defaults to free models. The one open gap: no scheduled cloud agent has actually been configured yet to consume the analysis_requests queue (Task 24). |  |  |  |  |  |  |