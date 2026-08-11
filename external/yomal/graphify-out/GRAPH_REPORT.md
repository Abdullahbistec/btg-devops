# Graph Report - .  (2026-07-23)

## Corpus Check
- 313 files · ~189,593 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2011 nodes · 4721 edges · 133 communities (112 shown, 21 thin omitted)
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 591 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- CLI Cost/Usage Analysis Commands
- Dashboard Chat API Controllers
- Dashboard UI Primitives (Badge/Header)
- Audits Page (Frontend)
- Cost Charts (Frontend)
- Dashboard API Routes
- Analysis Request Controllers
- Analysis Panel Component
- Dashboard API Routes (CRUD)
- Spec 1: Foundation/Auth Shell
- MCP Tools & Analysis Orchestration
- CLI Cost Analysis Command
- Dashboard API Routes (Resource)
- Usage/Cost Controllers
- Finding & KPI Cards (Frontend)
- TypeScript Config
- Resource-Type Analysis Docs Index
- Resource Controller Routes
- Cost Insights Builders
- Compare/Audit Detail Pages
- CDN/AFD Extractor
- Analysis Findings Queries
- Dashboard Dev Dependencies
- Findings HTTP Handler (Go)
- IAM Analyzer (Go)
- Cosmos DB Usage Tips
- Dashboard Runtime Dependencies
- Resource Group Analyzer (Go)
- CLI Engine CI/Release Workflows
- App Service Extractor (Go)
- Resource Cleaner (Go)
- Diagnostic Settings & IAM Scope
- ACR Extractor (Go)
- Cosmos DB Extractor (Go)
- Resources HTTP Handler (Go)
- ACR Usage Tips
- App Service Usage Tips
- Usage Helpers Tests
- Deep Research Analyze Method Docs
- Auth Login Route
- Subscription Controllers
- Chain-Finding/Data-Gaps Spec
- App Service Plan Analyzer (Go)
- DB Seed Admin (Go)
- Key Vault Usage Tips
- Cost Extractor (Go)
- User Controllers
- Parallel Per-Type Agents Spec
- Cognitive Services Usage Tips
- Public IP Usage Tips
- Storage Usage Tips
- Export Findings (Excel/PDF)
- Project Task List & Handoff Docs
- App Service Plan Usage Tips
- Functions Usage Tips
- User Role/Mailer Routes
- Chat Dock Component
- Chat HTTP Handler (Go)
- App Service Traffic Analyzer (Go)
- Auth Middleware (Go)
- NSG Analyzer (Go)
- LLM Client Wrapper (Dashboard)
- Region/Compliance Cards (Frontend)
- Data Gaps Feature
- User DB Repository (Go)
- Site Enrichment Tests (Go)
- Usage Extractor (Go)
- VM Extractor (Go)
- Cognitive Services Tests (Go)
- Storage Tests (Go)
- Storage Extractor (Go)
- Storage Analyzer (Go)
- Collect Command (Go)
- Key Vault Analyzer (Go)
- Public IP Analyzer (Go)
- ACR Tests (Go)
- Test Helpers (Go)
- Audit DB Repository (Go)
- DB Connection/Schema (Go)
- ACR Analyzer (Go)
- Cognitive Services Analyzer (Go)
- Cosmos DB Analyzer (Go)
- Audit Lifecycle DB (Go)
- Cosmos DB Tests (Go)
- Audit Summary Email
- Cosmos DB UI Fix Spec
- MCP Server & Scheduled Agent Design
- Auth HTTP Handler (Go)
- Collect-All Command (Go)
- Alert/Notification Recipients (Go)
- App Service Plan Extractor (Go)
- Cognitive Services Extractor (Go)
- NSG Tests (Go)
- Secret Encryption (Dashboard)
- Region/Compliance Data Logic (Frontend)
- Dashboard package.json Scripts
- Spec 7: Cost & Usage Extractors
- Audits HTTP Handler (Go)
- Session DB Repository (Go)
- Functions Auth Extraction Tests (Go)
- Findings DB Repository (Go)
- Idle Resources Command (Go)
- Analysis Request Cache DB (Go)
- Subscription DB Repository (Go)
- Scope Hash (Go)
- Public IP Tests (Go)
- Inventory Extractor (Go)
- Public IP Extractor (Go)
- App Service Plan Tests (Go)
- Bearer Token Auth Route
- CLI Entry Point (Go)
- Key Vault Crypto (Go)
- Section Header Component
- ESLint Config
- Next.js Config
- exceljs Dependency
- jsonwebtoken Dependency
- jspdf-autotable Dependency
- MCP SDK Dependency
- nodemailer Dependency
- react-dom Dependency
- zod Dependency
- @types/node Dependency
- PostCSS Config
- Vercel Deploy Workflow
- File Icon Asset
- Globe Icon Asset
- Next.js Logo Asset
- Vercel Logo Asset
- Window Icon Asset
- GitHub Repo: btg-devops
- GitHub Repo: btg-devops-api

## God Nodes (most connected - your core abstractions)
1. `requireAuth()` - 97 edges
2. `unauthorized()` - 94 edges
3. `assertContainsTip()` - 88 edges
4. `requireRole()` - 55 edges
5. `forbidden()` - 55 edges
6. `collectForSubscription()` - 36 edges
7. `useAuth()` - 28 edges
8. `deref()` - 27 edges
9. `extractResourceGroup()` - 25 edges
10. `api` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Rationale: Immediate Analyzer Trigger via /fire Endpoint Supersedes Cron Timing` --references--> `triggerAnalyzerRoutine()`  [EXTRACTED]
  .github/workflows/scheduled-audit.yml → CLI Engine/cmd/collect.go
- `CI Workflow (root)` --semantically_similar_to--> `CLI Engine CI Workflow`  [INFERRED] [semantically similar]
  .github/workflows/ci.yml → CLI Engine/.github/workflows/ci.yml
- `Scheduled Azure Audit Workflow (root)` --semantically_similar_to--> `CLI Engine Scheduled Azure Audit Workflow (legacy)`  [INFERRED] [semantically similar]
  .github/workflows/scheduled-audit.yml → CLI Engine/.github/workflows/scheduled-audit.yml
- `Scheduled Azure Audit Workflow (root)` --references--> `triggerAnalyzerRoutine()`  [EXTRACTED]
  .github/workflows/scheduled-audit.yml → CLI Engine/cmd/collect.go
- `Email Alerts Setup (secrets checklist)` --conceptually_related_to--> `btg-devops Project Task List (v2)`  [INFERRED]
  EMAIL_ALERTS_SETUP.md → graphify-out/converted/new-btg-devops-task-list_6ad4d1fd.md

## Import Cycles
- 3-file cycle: `dashboard/app/api/types/index.ts -> dashboard/app/api/utils/costInsights.ts -> dashboard/app/api/utils/usage.ts -> dashboard/app/api/types/index.ts`
- 3-file cycle: `dashboard/app/api/types/index.ts -> dashboard/app/api/utils/usageInsights.ts -> dashboard/app/api/utils/usage.ts -> dashboard/app/api/types/index.ts`

## Hyperedges (group relationships)
- **CI Build/Test/Lint Pipeline Pattern** — github_workflows_ci, cli_engine_github_workflows_ci, cli_engine_golangci [INFERRED 0.85]
- **Release Automation Pipeline (tag push -> binaries -> notes -> changelog)** — cli_engine_github_workflows_release, cli_engine_github_workflows_release_drafter, cli_engine_github_release_drafter, cli_engine_github_workflows_update_changelog [INFERRED 0.85]
- **Azure Audit Scheduling and Analyzer Trigger Mechanism** — github_workflows_scheduled_audit, cli_engine_github_workflows_scheduled_audit, cli_engine_cmd_collect_triggeranalyzerroutine [INFERRED 0.85]
- **Idle / Unused Resource Detection Pattern** — cli_engine_docs_001_appservice_traffic, cli_engine_docs_009_publicip_analysis, cli_engine_docs_010_appserviceplan_analysis, cli_engine_docs_usage_commands_analyze_idle [INFERRED 0.80]
- **Network Isolation / Public Access Hardening Checks** — cli_engine_docs_003_storage_analysis, cli_engine_docs_005_acr_analysis, cli_engine_docs_006_cosmosdb_analysis, cli_engine_docs_007_keyvault_analysis, cli_engine_docs_011_cognitiveservices_analysis, concept_public_network_access, concept_private_endpoint [INFERRED 0.85]
- **Resource Cost + Utilization Drill-Down Flow** — cli_engine_docs_usage_commands_analyze_usage, concept_cost_management_api, concept_azure_monitor_metrics, cli_engine_docs_usage_commands_waste_score [INFERRED 0.85]
- **Parallel per-type + synthesis flow for scope=="all"** — spec_agent_deep_research_playbook, spec_agent_parallel_per_type_agent_prompt, spec_agent_parallel_synthesis_agent_prompt [EXTRACTED 1.00]
- **Analyze pipeline evolution: direct API -> MCP orchestrator -> playbook** — spec_mainflow, spec_handoff_08_mcp_claude_orchestrator, spec_agent_deep_research_playbook, graphify_out_converted_new_btg_devops_task_list_6ad4d1fd [INFERRED 0.85]
- **Deep research + cache + parallel agents form one analyzer upgrade pipeline** — spec_handoff_10_deep_research_analysis_playbook, spec_handoff_13_parallel_resource_agents_pertypeagents, spec_handoff_13_parallel_resource_agents_synthesisagent, spec_handoff_14_analysis_cache_scopehash, spec_handoff_15_analyzer_upgrade_plan_phaseA [EXTRACTED 0.90]
- **Shared admin/analyst role-gate pattern reused across Subscriptions, Users, and Audit AI-analysis/Chat** — spec_handoff_04_subscriptions, spec_handoff_05_users, spec_handoff_03_audits_aianalysispanel, spec_handoff_03_audits_chatpanel [EXTRACTED 0.90]
- **Cost/usage extraction feeding analysis while deliberately excluded from scope caching** — spec_handoff_07_cost_usage_extractors_costextractor, spec_handoff_07_cost_usage_extractors_usageextractor, spec_handoff_03_audits_aianalysispanel, spec_handoff_14_analysis_cache_costusageexcluded_rationale [INFERRED 0.85]

## Communities (133 total, 21 thin omitted)

### Community 0 - "CLI Cost/Usage Analysis Commands"
Cohesion: 0.11
Nodes (53): strPtr(), Context, DefaultAzureCredential, runACRUsage(), Context, DefaultAzureCredential, runAppServiceUsage(), Context (+45 more)

### Community 1 - "Dashboard Chat API Controllers"
Cohesion: 0.07
Nodes (45): askChatController(), coerceProvider(), createThreadController(), deleteChatController(), deleteThreadController(), getChatMessageController(), listThreadsController(), saveChatController() (+37 more)

### Community 2 - "Dashboard UI Primitives (Badge/Header)"
Cohesion: 0.09
Nodes (38): Badge(), BadgeProps, Breadcrumb, Header(), HeaderProps, AccessDenied(), Modal(), ModalProps (+30 more)

### Community 3 - "Audits Page (Frontend)"
Cohesion: 0.09
Nodes (29): AuditsPage(), COLLECTION_STEPS, countsSummary(), parseStepIndex(), RunState, StepStatus, DashboardSearch(), severityIcons (+21 more)

### Community 4 - "Cost Charts (Frontend)"
Cohesion: 0.08
Nodes (35): CostTooltip(), CostTrendChart(), formatCurrency(), ServiceTooltip(), shortDate(), TopServicesChart(), CostBreakdownTabs(), SpendSpikesList() (+27 more)

### Community 5 - "Dashboard API Routes"
Cohesion: 0.12
Nodes (29): GET(), GET(), DELETE(), GET(), POST(), GET(), POST(), GET() (+21 more)

### Community 6 - "Analysis Request Controllers"
Cohesion: 0.09
Nodes (39): coerceProvider(), getAnalysisRequestController(), runAnalysisController(), saveAnalysisController(), findAnalysisRequestById(), AuditCostRaw, AuditCostUsageRaw, clearClaudeAnalysis() (+31 more)

### Community 7 - "Analysis Panel Component"
Cohesion: 0.11
Nodes (31): Analysis, AnalysisFinding, AnalysisPanel(), AnalysisPanelProps, AnalysisStore, normalizeStore(), severityIcons, severityTint (+23 more)

### Community 8 - "Dashboard API Routes (CRUD)"
Cohesion: 0.10
Nodes (31): DELETE(), GET(), PATCH(), GET(), POST(), deleteFindingController(), getFindingController(), listFindingsController() (+23 more)

### Community 9 - "Spec 1: Foundation/Auth Shell"
Cohesion: 0.08
Nodes (34): Spec 1 — Foundation, Design System & Auth Shell, API client (lib/api.ts), AuthGate component, AuthProvider / useAuth (lib/auth.tsx), Rationale: keep same AuthCtx shape as prototype so downstream components don't change, CSS variable design tokens (globals.css theme system), Header component, Sidebar component (+26 more)

### Community 10 - "MCP Tools & Analysis Orchestration"
Cohesion: 0.14
Nodes (29): createAnalysisRequestController(), findingSchema, registerTools(), sendSummaryEmailIfAuditComplete(), wakeRoutineIfCostUsageUnblocked(), AnalysisProgress, AnalysisRequest, checkScopeCacheHit() (+21 more)

### Community 11 - "CLI Cost Analysis Command"
Cohesion: 0.11
Nodes (25): anyToFloat64(), buildCostReport(), Command, Context, DefaultAzureCredential, QueryResult, Time, parseCostQueryResult() (+17 more)

### Community 12 - "Dashboard API Routes (Resource)"
Cohesion: 0.16
Nodes (22): POST(), DELETE(), GET(), PATCH(), GET(), POST(), POST(), createAuditController() (+14 more)

### Community 13 - "Usage/Cost Controllers"
Cohesion: 0.13
Nodes (28): formatUsageDate(), getAuditController(), getResourceDetailController(), getResourceTypeSummaryController(), getUsageSummaryController(), findAuditCostRaw(), findAuditCostUsageRaw(), findAuditResource() (+20 more)

### Community 14 - "Finding & KPI Cards (Frontend)"
Cohesion: 0.10
Nodes (20): FindingCard(), accents, CountUpValue(), KPICard(), KPICardProps, ChartSkeleton(), DetailSkeleton(), KPISkeletonRow() (+12 more)

### Community 15 - "TypeScript Config"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 16 - "Resource-Type Analysis Docs Index"
Cohesion: 0.15
Nodes (26): App Service Traffic Analysis, IAM Role Assignment Analysis, Storage Account Analysis, Network Security Group (NSG) Analysis, Container Registry (ACR) Analysis, Cosmos DB Analysis, Key Vault Analysis, Azure Functions Analysis (+18 more)

### Community 17 - "Resource Controller Routes"
Cohesion: 0.15
Nodes (19): GET(), createResourceController(), deleteResourceController(), getAuditResourceController(), getResourceController(), listResourcesController(), updateResourceController(), pool (+11 more)

### Community 18 - "Cost Insights Builders"
Cohesion: 0.18
Nodes (25): buildResourceList(), getCostSummaryController(), buildPrecomputedSignals(), buildDeltas(), buildResourceInfoLookup(), compareCostPeriods(), CostPeriodComparison, CostPeriodDelta (+17 more)

### Community 19 - "Compare/Audit Detail Pages"
Cohesion: 0.15
Nodes (18): ComparePageInner(), AuditDetailPage(), extraFieldsOf(), findResourceArray(), GroupedResourceTable(), locationOf(), RawDataSection(), resourceGroupOf() (+10 more)

### Community 20 - "CDN/AFD Extractor"
Cohesion: 0.16
Nodes (21): AFDCustomDomainsClient, AFDEndpointsClient, ExtractCDN(), fetchWAFPolicyMode(), Context, RawMessage, TokenCredential, lastPathSegment() (+13 more)

### Community 21 - "Analysis Findings Queries"
Cohesion: 0.15
Nodes (21): getAnalysisController(), findAnalysisById(), deleteFindingsByIds(), deleteFindingsByScope(), findPriorLiveFindings(), resolveFindingsByIds(), checklistForType(), CHECKLISTS (+13 more)

### Community 22 - "Dashboard Dev Dependencies"
Cohesion: 0.09
Nodes (23): devDependencies, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, @types/bcryptjs, @types/jsonwebtoken, @types/nodemailer (+15 more)

### Community 23 - "Findings HTTP Handler (Go)"
Cohesion: 0.19
Nodes (13): Pool, Request, ResponseWriter, NewFindingsHandler(), ResponseWriter, writeError(), writeJSON(), Pool (+5 more)

### Community 24 - "IAM Analyzer (Go)"
Cohesion: 0.15
Nodes (18): AnalyzeIAMFindings(), classifyScope(), derefPT(), Command, lastSegment(), printIAMTable(), runIAM(), boolSeverity() (+10 more)

### Community 25 - "Cosmos DB Usage Tips"
Cohesion: 0.23
Nodes (20): BuildCosmosAccountTips(), BuildCosmosDatabaseTips(), T, TestBuildCosmosAccountTips_FreeTierAlreadyEnabled(), TestBuildCosmosAccountTips_FreeTierNotEnabled(), TestBuildCosmosAccountTips_HealthyAccount(), TestBuildCosmosAccountTips_MultiRegion(), TestBuildCosmosAccountTips_NoBackupPolicy() (+12 more)

### Community 26 - "Dashboard Runtime Dependencies"
Cohesion: 0.10
Nodes (21): @anthropic-ai/sdk, @azure/identity, @azure/keyvault-secrets, bcryptjs, dependencies, @anthropic-ai/sdk, @azure/identity, @azure/keyvault-secrets (+13 more)

### Community 27 - "Resource Group Analyzer (Go)"
Cohesion: 0.16
Nodes (17): AnalyzeRGFindings(), Client, Command, Context, isRGEmpty(), printRGReport(), rgHasLock(), runResourceGroup() (+9 more)

### Community 28 - "CLI Engine CI/Release Workflows"
Cohesion: 0.10
Nodes (20): CLI Engine Release Drafter Config, CLI Engine CI Workflow, CLI Engine Release Workflow, CLI Engine Release Drafter Workflow, Update Changelog Workflow, .golangci.yml Lint Configuration, btg-devops README, Container Registry (ACR) Analysis feature (+12 more)

### Community 29 - "App Service Extractor (Go)"
Cohesion: 0.14
Nodes (19): ExtractAppService(), Context, RawMessage, TimeSeriesElement, TokenCredential, sumTimeseries(), EnrichSite(), Context (+11 more)

### Community 30 - "Resource Cleaner (Go)"
Cohesion: 0.15
Nodes (18): CleanResource(), CleanResources(), extractResourceGroup(), RawMessage, T, T, TestCleanResource_ExtractsResourceGroupFromID(), TestCleanResource_LowercaseResourceGroupsSegment() (+10 more)

### Community 31 - "Diagnostic Settings & IAM Scope"
Cohesion: 0.13
Nodes (18): addDiagnosticSettings(), Context, TokenCredential, classifyScopeLevel(), derefStr(), ExtractIAM(), Context, TokenCredential (+10 more)

### Community 32 - "ACR Extractor (Go)"
Cohesion: 0.12
Nodes (16): ExtractACR(), Context, RawMessage, TokenCredential, ExtractNSG(), Context, RawMessage, TokenCredential (+8 more)

### Community 33 - "Cosmos DB Extractor (Go)"
Cohesion: 0.17
Nodes (17): ExtractCosmosDB(), Context, RawMessage, TokenCredential, FetchCosmosRUPricing(), fetchRetailPrices(), Client, Context (+9 more)

### Community 34 - "Resources HTTP Handler (Go)"
Cohesion: 0.23
Nodes (14): Pool, Request, ResponseWriter, NewResourceHandler(), GetAuditResource(), GetResourceByID(), GetResourceBySlug(), Context (+6 more)

### Community 35 - "ACR Usage Tips"
Cohesion: 0.32
Nodes (17): BuildACRUsageTips(), assertContainsTip(), T, TestBuildACRUsageTips_AdminEnabled(), TestBuildACRUsageTips_BasicSKUHighCost(), TestBuildACRUsageTips_BasicSKULowCostNoTip(), TestBuildACRUsageTips_HighBuildMeter(), TestBuildACRUsageTips_HighStorageMeter() (+9 more)

### Community 36 - "App Service Usage Tips"
Cohesion: 0.27
Nodes (17): BuildAppServiceUsageTips(), T, TestBuildAppServiceUsageTips_AlwaysOnDisabledHighCost(), TestBuildAppServiceUsageTips_AlwaysOnDisabledLowCostNoTip(), TestBuildAppServiceUsageTips_BandwidthMeter(), TestBuildAppServiceUsageTips_HTTP2Disabled(), TestBuildAppServiceUsageTips_HTTPSNotEnforced(), TestBuildAppServiceUsageTips_NoClientCertHighCost() (+9 more)

### Community 37 - "Usage Helpers Tests"
Cohesion: 0.20
Nodes (18): T, TestBuildUtilizationString_Empty(), TestBuildUtilizationString_Float(), TestBuildUtilizationString_Integer(), TestBuildUtilizationString_MultipleEntriesSorted(), TestCalcWasteScore_ActivityBased(), TestCalcWasteScore_PercentageBased(), TestCalcWasteScore_ZeroCost() (+10 more)

### Community 38 - "Deep Research Analyze Method Docs"
Cohesion: 0.12
Nodes (19): dashboard/AGENTS.md — Next.js breaking-changes notice, dashboard/CLAUDE.md, dashboard/README.md (create-next-app default), Five-stage deep research process (map, correlate, chain, judge, verify), How Analyze works: old method vs. new (deep research), New deep-research Analyze method (5-step investigation), Old Analyze method (one-shot direct API call), BTG DevOps Dashboard — Frontend Specification (+11 more)

### Community 39 - "Auth Login Route"
Cohesion: 0.22
Nodes (13): POST(), POST(), loginController(), logoutController(), extractBearer(), verifyToken(), findSession(), hashToken() (+5 more)

### Community 40 - "Subscription Controllers"
Cohesion: 0.22
Nodes (15): createSubscriptionController(), deleteSubscriptionController(), getSubscriptionController(), listSubscriptionsController(), updateSubscriptionController(), deleteSubscription(), findAllSubscriptions(), findSubscriptionById() (+7 more)

### Community 41 - "Chain-Finding/Data-Gaps Spec"
Cohesion: 0.15
Nodes (19): spec/handoff/10-deep-research-analysis.md (deep research strategy spec), Chain-finding schema (finding_type, data_gaps) + UI, analysisChecklists.ts per-resource-type checklists (Phase 2), data_gaps feedback loop, 'deep' analysis_requests scope, get_audit_history MCP tool, deep-research-playbook.md (5-stage playbook), Rationale: skip building VM/NIC extractor — confirmed zero VMs in audited subscription (+11 more)

### Community 42 - "App Service Plan Analyzer (Go)"
Cohesion: 0.22
Nodes (15): analyzeASPs(), AnalyzeASPsData(), getASPMetrics(), Command, Context, MetricsClient, Plan, WebAppsClient (+7 more)

### Community 43 - "DB Seed Admin (Go)"
Cohesion: 0.11
Nodes (12): Command, runSeedAdmin(), Connect(), Context, Pool, ApplySchema(), Context, Pool (+4 more)

### Community 44 - "Key Vault Usage Tips"
Cohesion: 0.28
Nodes (16): BuildKeyVaultUsageTips(), T, TestBuildKeyVaultUsageTips_HealthyVault(), TestBuildKeyVaultUsageTips_HighOperationsMeter(), TestBuildKeyVaultUsageTips_LegacyAccessPolicies(), TestBuildKeyVaultUsageTips_LongRetention(), TestBuildKeyVaultUsageTips_NetworkAllowAll(), TestBuildKeyVaultUsageTips_NoPurgeProtection() (+8 more)

### Community 45 - "Cost Extractor (Go)"
Cohesion: 0.18
Nodes (17): ExtractCost(), fetchCostPage(), Context, QueryResult, RawMessage, Time, TokenCredential, queryCostRows() (+9 more)

### Community 46 - "User Controllers"
Cohesion: 0.20
Nodes (15): createUserController(), deleteUserController(), getUserController(), listUsersController(), updateUserController(), deleteUser(), findUserById(), insertUser() (+7 more)

### Community 47 - "Parallel Per-Type Agents Spec"
Cohesion: 0.20
Nodes (18): spec/handoff/13-parallel-resource-agents.md (related-types map, 14 per-type agents), B7 prototype run results (5 chain findings, 5.8x token cost), list_changed_scopes / get_cached_scope_analysis MCP tools, 12-14 parallel per-resource-type agents (Phase 1), Related-types map (universal context + clusters), Fan-out triggers only on scope==='all', Synthesis agent (only caller of save_analysis), Rationale: synthesis, not per-type agents, owns save_analysis write (avoids race, enables refutation with full context) (+10 more)

### Community 48 - "Cognitive Services Usage Tips"
Cohesion: 0.29
Nodes (15): BuildCogServicesAccountTips(), T, TestBuildCogServicesAccountTips_HealthyAccount(), TestBuildCogServicesAccountTips_LocalAuthDisabledNoTip(), TestBuildCogServicesAccountTips_LocalAuthEnabled(), TestBuildCogServicesAccountTips_NonOpenAIHighCost(), TestBuildCogServicesAccountTips_NonOpenAILowCostNoTip(), TestBuildCogServicesAccountTips_OpenAINoDeployments() (+7 more)

### Community 49 - "Public IP Usage Tips"
Cohesion: 0.31
Nodes (16): BuildPublicIPUsageTips(), T, TestBuildPublicIPUsageTips_AttachedIPNoUnattachedTip(), TestBuildPublicIPUsageTips_BasicHighCost(), TestBuildPublicIPUsageTips_BasicSKUAttached(), TestBuildPublicIPUsageTips_DynamicUnattachedNoStaticTip(), TestBuildPublicIPUsageTips_HighDataTransfer(), TestBuildPublicIPUsageTips_HighIdleTimeout() (+8 more)

### Community 50 - "Storage Usage Tips"
Cohesion: 0.29
Nodes (15): BuildStorageAccountTips(), T, TestBuildStorageAccountTips_BlobPublicAccessNoContainers(), TestBuildStorageAccountTips_BlobPublicAccessWithPublicContainers(), TestBuildStorageAccountTips_CoolTierNoHotTip(), TestBuildStorageAccountTips_GRSHighCost(), TestBuildStorageAccountTips_HealthyAccount(), TestBuildStorageAccountTips_HotTierHighCost() (+7 more)

### Community 51 - "Export Findings (Excel/PDF)"
Cohesion: 0.20
Nodes (15): ScopeShareData, exportFindingsAsExcel(), exportFindingsAsPDF(), triggerDownload(), BRAND_PURPLE_RGB, buildExcelWorkbook(), buildPDFDoc(), ExportableFinding (+7 more)

### Community 52 - "Project Task List & Handoff Docs"
Cohesion: 0.19
Nodes (17): Email Alerts Setup (secrets checklist), CLI Engine internal/mailer package, btg-devops Project Task List (v2), Analyzer cache + parallel agents work (Spec 13/14/15), Missing scheduled Claude Code cloud agent (Task 23/24 gap), Deep Research Playbook (scheduled agent instructions), scope=="all" parallel fan-out special case, Chain finding pattern (finding_type: chain) (+9 more)

### Community 53 - "App Service Plan Usage Tips"
Cohesion: 0.31
Nodes (14): BuildASPUsageTips(), T, TestBuildASPUsageTips_BasicTierManyApps(), TestBuildASPUsageTips_FreeSharedTier(), TestBuildASPUsageTips_IdlePlan(), TestBuildASPUsageTips_MaxWorkersHighCurrentLow(), TestBuildASPUsageTips_NewPv3SKUNoUpgradeTip(), TestBuildASPUsageTips_OldPv2SKU() (+6 more)

### Community 54 - "Functions Usage Tips"
Cohesion: 0.31
Nodes (14): BuildFunctionsUsageTips(), T, TestBuildFunctionsUsageTips_ConsumptionAlwaysOnEnabled(), TestBuildFunctionsUsageTips_ConsumptionHealthy(), TestBuildFunctionsUsageTips_ConsumptionHighCost(), TestBuildFunctionsUsageTips_DedicatedPlanHighCost(), TestBuildFunctionsUsageTips_DedicatedPlanLowCostNoTip(), TestBuildFunctionsUsageTips_ElasticPremiumHighCost() (+6 more)

### Community 55 - "User Role/Mailer Routes"
Cohesion: 0.25
Nodes (11): POST(), findRoleSettings(), findAllUsers(), buildTransport(), MailAttachment, resolveNotificationRecipients(), resolveShareRecipients(), sendMail() (+3 more)

### Community 56 - "Chat Dock Component"
Cohesion: 0.21
Nodes (13): ChatDock(), ChatDockProps, clampWidth(), ChatPanel(), ChatPanelProps, renderBold(), SUGGESTIONS, buildScopeGroups() (+5 more)

### Community 57 - "Chat HTTP Handler (Go)"
Cohesion: 0.21
Nodes (11): Pool, Request, ResponseWriter, NewChatHandler(), Context, Pool, Time, ListMessages() (+3 more)

### Community 58 - "App Service Traffic Analyzer (Go)"
Cohesion: 0.21
Nodes (12): ClassifyTrafficStatus(), formatBytes(), getSubscriptionID(), Command, TimeSeriesElement, printTable(), runAppServiceTraffic(), sumMetricTimeseries() (+4 more)

### Community 59 - "Auth Middleware (Go)"
Cohesion: 0.22
Nodes (13): Auth(), extractBearer(), Context, Pool, Request, parseJWT(), RequireRole(), RoleFromContext() (+5 more)

### Community 60 - "NSG Analyzer (Go)"
Cohesion: 0.29
Nodes (12): AnalyzeNSGFindings(), collectPortStrings(), Command, SecurityGroup, parsePortRangesFromStrings(), portInRanges(), printNSGTable(), runNSG() (+4 more)

### Community 61 - "LLM Client Wrapper (Dashboard)"
Cohesion: 0.23
Nodes (12): callClaude(), callGemini(), callLLM(), callLLMWithFallback(), callOpenRouter(), claudeClient(), isRetryable(), LLMCall (+4 more)

### Community 62 - "Region/Compliance Cards (Frontend)"
Cohesion: 0.22
Nodes (8): ServiceDot(), RegionListCard(), CrossRegionCheck(), RegionDistributionChart(), ResourceChart(), CATEGORICAL, categoricalColor(), RegionSummary

### Community 63 - "Data Gaps Feature"
Cohesion: 0.29
Nodes (10): listDataGapsController(), DataGapMark, findAllDataGapMarks(), isMissingTable(), upsertDataGapMark(), DataGapsView, findDataGaps(), ScopeRun (+2 more)

### Community 64 - "User DB Repository (Go)"
Cohesion: 0.35
Nodes (11): CreateUser(), GetUserByEmail(), Context, Pool, Time, ListUsers(), UpdateLastLogin(), UpdateUser() (+3 more)

### Community 65 - "Site Enrichment Tests (Go)"
Cohesion: 0.32
Nodes (11): reduceAuthSettings(), boolP(), T, int32P(), strP(), TestMergeIntoJSON_AddsFieldsAndSkipsNil(), TestReduceAppSettings_NamesOnlyAndKeyVaultRefs(), TestReduceAuthSettings_EnabledProvidersAndAction() (+3 more)

### Community 66 - "Usage Extractor (Go)"
Cohesion: 0.27
Nodes (11): armTypeFromResourceID(), cleanMetricResult(), ExtractUsage(), Client, Context, RawMessage, TokenCredential, listResourceIDsByType() (+3 more)

### Community 67 - "VM Extractor (Go)"
Cohesion: 0.23
Nodes (10): ExtractVM(), fetchPowerState(), Context, RawMessage, TokenCredential, powerStateFromCodes(), T, TestPowerStateFromCodes() (+2 more)

### Community 68 - "Cognitive Services Tests (Go)"
Cohesion: 0.23
Nodes (11): cogAccount(), cogNetworkAction(), cogProvisioningState(), cogPublicAccess(), Account, AccountProperties, PublicNetworkAccess, T (+3 more)

### Community 69 - "Storage Tests (Go)"
Cohesion: 0.23
Nodes (11): defaultAction(), Account, AccountProperties, PublicNetworkAccess, T, networkAccess(), storageAccount(), TestAnalyzeStorageFindings() (+3 more)

### Community 70 - "Storage Extractor (Go)"
Cohesion: 0.29
Nodes (10): BlobContainersClient, addContainerFields(), addLifecyclePolicy(), ExtractStorage(), Context, RawMessage, TokenCredential, storageContainer (+2 more)

### Community 71 - "Storage Analyzer (Go)"
Cohesion: 0.29
Nodes (9): extractResourceGroup(), AnalyzeStorageFindings(), Account, Command, printStorageTable(), runStorage(), StorageFinding, StorageReport (+1 more)

### Community 72 - "Collect Command (Go)"
Cohesion: 0.27
Nodes (9): collectForSubscription(), countResources(), Command, Context, runCollect(), triggerAnalyzerRoutine(), CLI Engine Scheduled Azure Audit Workflow (legacy), Scheduled Azure Audit Workflow (root) (+1 more)

### Community 73 - "Key Vault Analyzer (Go)"
Cohesion: 0.27
Nodes (9): AnalyzeKeyVaultFindings(), Command, Time, Vault, printKeyVaultTable(), runKeyVault(), KeyVaultFinding, KeyVaultReport (+1 more)

### Community 74 - "Public IP Analyzer (Go)"
Cohesion: 0.31
Nodes (8): AnalyzePublicIPs(), Command, PublicIPAddress, printPublicIPReport(), runPublicIP(), PublicIPFinding, PublicIPReport, PublicIPSummary

### Community 75 - "ACR Tests (Go)"
Cohesion: 0.24
Nodes (10): acrPublicAccess(), acrRegistry(), PublicNetworkAccess, Registry, T, retentionStatus(), TestAnalyzeACRFindings(), PolicyStatus (+2 more)

### Community 76 - "Test Helpers (Go)"
Cohesion: 0.24
Nodes (9): boolPtr(), int32Ptr(), T, Vault, kvKeyPerm(), kvVault(), TestAnalyzeKeyVaultFindings(), KeyPermissions (+1 more)

### Community 77 - "Audit DB Repository (Go)"
Cohesion: 0.44
Nodes (9): GetAudit(), Context, Pool, RawMessage, Time, ListAudits(), SaveClaudeAnalysis(), AuditDetail (+1 more)

### Community 78 - "DB Connection/Schema (Go)"
Cohesion: 0.20
Nodes (7): Connect(), Context, Pool, ApplySchema(), Context, Pool, main()

### Community 79 - "ACR Analyzer (Go)"
Cohesion: 0.31
Nodes (8): AnalyzeACRFindings(), Command, Registry, printACRTable(), runACR(), ACRFinding, ACRReport, ACRSummary

### Community 80 - "Cognitive Services Analyzer (Go)"
Cohesion: 0.31
Nodes (8): AnalyzeCogServicesFindings(), Account, Command, printCognitiveServicesTable(), runCognitiveServices(), CognitiveServicesFinding, CognitiveServicesReport, CognitiveServicesSummary

### Community 81 - "Cosmos DB Analyzer (Go)"
Cohesion: 0.31
Nodes (8): AnalyzeCosmosDBFindings(), Command, DatabaseAccountGetResults, printCosmosDBTable(), runCosmosDB(), CosmosDBFinding, CosmosDBReport, CosmosDBSummary

### Community 82 - "Audit Lifecycle DB (Go)"
Cohesion: 0.42
Nodes (9): CompleteAudit(), CreateAudit(), FailAudit(), Context, Pool, RawMessage, SaveCostUsageData(), UpdateAuditStep() (+1 more)

### Community 83 - "Cosmos DB Tests (Go)"
Cohesion: 0.27
Nodes (9): cosmosAccount(), cosmosConsistency(), cosmosPublicAccess(), DatabaseAccountGetResults, PublicNetworkAccess, T, TestAnalyzeCosmosDBFindings(), DatabaseAccountGetProperties (+1 more)

### Community 84 - "Audit Summary Email"
Cohesion: 0.42
Nodes (9): findAuditById(), findFindingsByAudit(), buildAuditSummaryEmail(), buildScopeShareData(), escapeHtml(), SEVERITY_COLOR, severityCountsHtml(), runChat() (+1 more)

### Community 85 - "Cosmos DB UI Fix Spec"
Cohesion: 0.22
Nodes (10): Findings severity + resource-type filters, Option 2: richer finding fields (estimated_monthly_savings, confidence), fix_effort field + Quick Wins UI (Phase 3), btg-devops Dashboard — Cosmos DB Analysis Fix Spec, Bug 3: redundant 'ACCOUNT-LEVEL' label, Bug 1: duplicate account rendering (shared vs per-account findings merged), Rationale: fix recommendation formatting at prompt+schema source, not with client-side string parsing, Bug 2: 'no cost data' badge shown on every finding (+2 more)

### Community 86 - "MCP Server & Scheduled Agent Design"
Cohesion: 0.27
Nodes (10): spec/handoff/08-mcp-claude-orchestrator.md (MCP server + scheduled agent architecture), analysis_requests table, Rationale: choose MCP server + Claude Code orchestrator over spawning claude CLI subprocess (ToS risk, reliability), btg-devops MCP server (list_pending_requests/get_audit_data/save_analysis), Scheduled Claude Code cloud agent (routine), triggerAnalyzerRoutine() / routine /fire endpoint, Spec 9 — Improving Analyze/Chat recommendation quality (idea backlog), Option 3: learn from dismissals (dismissal_reason) (+2 more)

### Community 87 - "Auth HTTP Handler (Go)"
Cohesion: 0.39
Nodes (6): extractBearerFromRequest(), Pool, Request, ResponseWriter, NewAuthHandler(), AuthHandler

### Community 88 - "Collect-All Command (Go)"
Cohesion: 0.39
Nodes (7): captureJSON(), Command, RawMessage, runAll(), runAllJSON(), runAllTable(), analyzerDef

### Community 89 - "Alert/Notification Recipients (Go)"
Cohesion: 0.31
Nodes (7): failAndAlert(), Pool, FindActiveUserEmailsByRoles(), FindEnabledRoles(), Context, Pool, SendAlert()

### Community 90 - "App Service Plan Extractor (Go)"
Cohesion: 0.33
Nodes (8): ExtractAppServicePlan(), Context, RawMessage, TokenCredential, sitesByServerFarm(), RawMessage, mergeIntoJSON(), AppServicePlanData

### Community 91 - "Cognitive Services Extractor (Go)"
Cohesion: 0.33
Nodes (8): ExtractCognitiveServices(), fetchCognitiveServicesMetrics(), Context, MetricsClient, RawMessage, TokenCredential, CognitiveServicesData, CognitiveServicesMetrics

### Community 92 - "NSG Tests (Go)"
Cohesion: 0.28
Nodes (8): strPtr(), SecurityGroup, T, nsgWithRule(), TestAnalyzeNSGFindings(), SecurityRuleAccess, SecurityRuleDirection, SecurityRuleProtocol

### Community 93 - "Secret Encryption (Dashboard)"
Cohesion: 0.44
Nodes (8): aesDecrypt(), aesEncrypt(), decryptSecret(), encryptSecret(), getAESKey(), getKeyVaultClient(), kvDecrypt(), kvEncrypt()

### Community 94 - "Region/Compliance Data Logic (Frontend)"
Cohesion: 0.33
Nodes (8): COMPUTE_TYPES, computeCrossRegionMismatches(), computeRegionDistribution(), DATA_TYPES, extractResources(), RegionDistributionEntry, RegionMismatch, RegionResource

### Community 95 - "Dashboard package.json Scripts"
Cohesion: 0.22
Nodes (8): name, private, scripts, build, dev, lint, start, version

### Community 96 - "Spec 7: Cost & Usage Extractors"
Cohesion: 0.31
Nodes (9): Spec 7 — Cost & Usage Extractors (CLI) + Dashboard Integration, Rationale: reject calcWasteScore()-style hardcoded Go judgment thresholds — Claude should interpret, not Go, collect.go extractor pipeline wiring, ExtractCost (internal/extractors/cost.go), Legacy costanalysis.go / usage.go commands, ExtractUsage (internal/extractors/usage.go), Option 1: sharper org-specific instructions per scope, Severity rubric + evidence requirement (Phase 1) (+1 more)

### Community 97 - "Audits HTTP Handler (Go)"
Cohesion: 0.39
Nodes (5): Pool, Request, ResponseWriter, NewAuditHandler(), AuditHandler

### Community 98 - "Session DB Repository (Go)"
Cohesion: 0.57
Nodes (7): CreateSession(), DeleteExpiredSessions(), DeleteSession(), Context, Pool, hashToken(), ValidateSession()

### Community 99 - "Functions Auth Extraction Tests (Go)"
Cohesion: 0.43
Nodes (7): errString(), extractHTTPTriggerAuth(), T, TestErrString(), TestExtractHTTPTriggerAuth_FindsAuthLevelOnTriggerBinding(), TestExtractHTTPTriggerAuth_MalformedConfigReturnsEmpty(), TestExtractHTTPTriggerAuth_NonHTTPTriggerHasNoAuthLevel()

### Community 100 - "Findings DB Repository (Go)"
Cohesion: 0.48
Nodes (6): Context, Pool, Time, ListFindings(), SaveFinding(), Finding

### Community 101 - "Idle Resources Command (Go)"
Cohesion: 0.48
Nodes (5): Command, outputIdleJSON(), printIdleReport(), runIdle(), idleEntry

### Community 102 - "Analysis Request Cache DB (Go)"
Cohesion: 0.52
Nodes (6): Context, Pool, PreviousAnalyzedScopeHash(), QueueAnalysisRequests(), TrailingCacheHitStreak(), ScopeToQueue

### Community 103 - "Subscription DB Repository (Go)"
Cohesion: 0.57
Nodes (6): FindAllActiveSubscriptions(), FindSubscriptionCredentials(), Context, Pool, TouchLastAudit(), SubscriptionCredentials

### Community 104 - "Scope Hash (Go)"
Cohesion: 0.48
Nodes (5): ScopeHash(), T, TestScopeHash_ChangesWithData(), TestScopeHash_StableAcrossRuns(), TestScopeHash_UnaffectedByMapKeyOrder()

### Community 105 - "Public IP Tests (Go)"
Cohesion: 0.33
Nodes (6): PublicIPAddress, T, pip(), TestAnalyzePublicIPs(), IPAllocationMethod, PublicIPAddressSKUName

### Community 106 - "Inventory Extractor (Go)"
Cohesion: 0.47
Nodes (5): ExtractInventory(), Context, TokenCredential, InventoryData, InventoryResource

### Community 107 - "Public IP Extractor (Go)"
Cohesion: 0.40
Nodes (5): ExtractPublicIP(), Context, RawMessage, TokenCredential, PublicIPData

### Community 108 - "App Service Plan Tests (Go)"
Cohesion: 0.50
Nodes (4): aspPlan(), Plan, T, TestAnalyzeASPsData()

### Community 109 - "Bearer Token Auth Route"
Cohesion: 0.80
Nodes (4): checkBearerToken(), GET(), POST(), unauthorized()

### Community 111 - "Key Vault Crypto (Go)"
Cohesion: 0.83
Nodes (3): aesDecrypt(), DecryptSecret(), kvDecrypt()

## Knowledge Gaps
- **206 isolated node(s):** `github.com/chanbistec/btg-devops-api`, `contextKey`, `github.com/chanbistec/btg-devops`, `fakeResource`, `diagnosticSetting` (+201 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getSubscriptionID()` connect `App Service Traffic Analyzer (Go)` to `CLI Cost/Usage Analysis Commands`, `Idle Resources Command (Go)`, `Storage Analyzer (Go)`, `Collect Command (Go)`, `Key Vault Analyzer (Go)`, `App Service Plan Analyzer (Go)`, `CLI Cost Analysis Command`, `Public IP Analyzer (Go)`, `ACR Analyzer (Go)`, `Cognitive Services Analyzer (Go)`, `Cosmos DB Analyzer (Go)`, `Collect-All Command (Go)`, `IAM Analyzer (Go)`, `Resource Group Analyzer (Go)`, `NSG Analyzer (Go)`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Why does `runCollect()` connect `Collect Command (Go)` to `App Service Traffic Analyzer (Go)`, `DB Seed Admin (Go)`, `Subscription DB Repository (Go)`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Why does `collectForSubscription()` connect `Collect Command (Go)` to `CDN/AFD Extractor`, `App Service Extractor (Go)`, `Resource Cleaner (Go)`, `Diagnostic Settings & IAM Scope`, `ACR Extractor (Go)`, `Cosmos DB Extractor (Go)`, `Cost Extractor (Go)`, `Usage Extractor (Go)`, `VM Extractor (Go)`, `Storage Extractor (Go)`, `Audit Lifecycle DB (Go)`, `Alert/Notification Recipients (Go)`, `App Service Plan Extractor (Go)`, `Cognitive Services Extractor (Go)`, `Analysis Request Cache DB (Go)`, `Subscription DB Repository (Go)`, `Scope Hash (Go)`, `Inventory Extractor (Go)`, `Public IP Extractor (Go)`, `Key Vault Crypto (Go)`?**
  _High betweenness centrality (0.088) - this node is a cross-community bridge._
- **Are the 76 inferred relationships involving `assertContainsTip()` (e.g. with `TestBuildAppServiceUsageTips_AlwaysOnDisabledHighCost()` and `TestBuildAppServiceUsageTips_BandwidthMeter()`) actually correct?**
  _`assertContainsTip()` has 76 INFERRED edges - model-reasoned connections that need verification._
- **What connects `github.com/chanbistec/btg-devops-api`, `contextKey`, `github.com/chanbistec/btg-devops` to the rest of the system?**
  _206 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CLI Cost/Usage Analysis Commands` be split into smaller, more focused modules?**
  _Cohesion score 0.10841750841750841 - nodes in this community are weakly interconnected._
- **Should `Dashboard Chat API Controllers` be split into smaller, more focused modules?**
  _Cohesion score 0.07039187227866474 - nodes in this community are weakly interconnected._