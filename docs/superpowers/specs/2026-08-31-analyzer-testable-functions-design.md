# Analyzer Testable-Function Port — Design

Date: 2026-08-31
Branch: abd-production-2

## Context

The original framing for this work (docs/superpowers/plans/2026-08-29-unified-postgres-schema.md's roadmap, Sub-project 2) was "merge two Go codebases" — this repo's own `cmd/` and a related product's `external/yomal/CLI Engine/`. A full investigation (13 parallel per-file comparisons plus follow-up passes on the `provider` package, the Yomal-exclusive extractors, and Power Platform) found the actual scope is much smaller than that framing suggested.

**What the investigation found:**

- Both codebases' 13 overlapping analyzer files (`acr`, `appservice_traffic`, `appserviceplan`, `cognitiveservices`, `cosmosdb`, `functions`, `iam`, `idle`, `keyvault`, `nsg`, `publicip`, `resourcegroup`, `storage`) share identical core detection logic — same checks, same thresholds, same severities. They diverge only in two additive ways:
  - This repo's version (`cmd/`) integrates each analyzer with a real, working `provider` package (`provider/analyzer.go` + `provider/registry.go`) — an `Analyzer` interface (`Name() string`, `Run(ctx) ([]Finding, error)`) that `provider.Register("azure", adapter)` feeds into, consumed today by `cmd/analyze_azure.go` and `cmd/analyze_hetzner.go` (`provider.Run(ctx, "azure")`) for in-process cross-service aggregation. This is load-bearing production code, not incidental.
  - Yomal's version adds a pure, client-less `AnalyzeXFindings(preloadedData) []Finding`-shaped function per file — the same check logic, but callable against already-fetched data with no Azure client, for unit testing. This repo's files have no equivalent test seam today (confirmed: none of the 13 files have a table-driven test of their check logic, only `cmd/idle_test.go`/`cmd/hetzner_findings_test.go`/`cmd/pp_test.go` cover other things).
  - `cmd/idle.go` is the one exception: it's already a strict superset of Yomal's version (this repo's copy already has everything Yomal's has, plus the `provider` integration Yomal's lacks). Nothing to port there.
  - Yomal's copies have a recurring encoding defect: several files (`appservice_traffic`, `cosmosdb`, `functions`, `nsg`, `resourcegroup`) have mojibake in string literals (`â€"` for em-dash, `ðŸŽ‰` for 🎉, `â€¢` for •) from a UTF-8/Windows-1252 double-encoding mismatch at some point in that codebase's history. Not present in this repo's copies.
- **`vm`/`cdn` extractors** (`internal/extractors/vm.go`, `cdn.go`), named in the original roadmap as "Yomal-exclusive extractors to fold in," turn out to have **no findings/check logic at all** — they're raw inventory fetchers (`ExtractVM`/`ExtractCDN`) with no Cobra command, called only from `cmd/collect.go`'s extraction pipeline. Porting them as real analyzers (matching the other 13's Cobra-command-plus-checks shape) would be net-new feature work, not a merge — there is nothing existing to port.
- **`usage_*.go` files** (originally assumed part of the "vm/cdn/cost/usage" exclusive set) are in fact already present in both codebases and 10-of-12 are byte-identical; the other 2 (`usage.go`, `usage_acr.go`) differ by 19 and 2 lines respectively (see Task 14).
- **Power Platform**: this repo's implementation (`pp_environments.go`, `pp_apps.go`, `pp_flows.go`, `pp_powerbi.go`, plus `powerplatform.go`'s license analyzer, which Yomal has no equivalent of at all) already has 8-9 real finding categories per resource type. Yomal's `internal/extractors/powerplatform/*.go` does raw data extraction only (e.g. Yomal's `apps.go` is 99 lines vs. this repo's 486), feeding `collect.go`, with zero evaluation logic. Nothing to port in.
- **Hetzner**: zero Yomal equivalent, confirmed by repo-wide grep. Not touched by this work.
- **7 of `collect.go`'s other support extractors** (`cleaner`, `diagnostics`, `inventory`, `pricing`, `scopehash`, `site_enrich`, `appservice` — all under Yomal's `internal/extractors/`) are pure plumbing with zero standalone callers anywhere — each is only ever invoked by another extractor or by `collect.go` itself, and none writes to Postgres directly. `internal/extractors/cost.go` (not individually re-verified, but matching this same pattern in every other case checked) is assumed to be the same category — a `collect.go`-only helper, not a standalone check.
- **`cmd/collect.go`, `cmd/collect_test.go`, `cmd/seedadmin.go`**: the Go-side direct-Postgres-write path. Explicitly out of scope — see Non-goals.
- **`cmd/costanalysis.go`** (standalone, no DB, queries Azure Cost Management directly) and **`cmd/all.go`** (standalone, no DB, runs Yomal's 12 analyzers in-process and merges output — this repo's `analyze_all.go` already serves an equivalent role via subprocess re-exec, per the older 2026-08-06 spec below) both have no Postgres dependency but are not part of this pass's scope either — see Non-goals.
- A separate, earlier design doc, `docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md`, proposed a *different* shared-interface mechanism (`cmd/analyzer.go`'s `UnifiedFinding`, wired into `analyze_all.go` in-process). What was actually built instead is the `provider` package described above, wired into `analyze_azure.go`/`analyze_hetzner.go` — `analyze_all.go` was never migrated onto it and still shells out via `os/exec` per-command. That 2026-08-06 doc is superseded by what actually shipped and is not the design this spec follows; it's noted here only so a future reader doesn't chase two different "the" analyzer interfaces.

**Decisions confirmed with the user this session:**

1. This repo's module (`cmd/` at the repo root) is the surviving side — nothing from Yomal's module is imported wholesale. (In practice, given the findings above, this means: nothing at all needs to change about module structure, since every port in this plan is a small, hand-copied function, not an import of Yomal's package.)
2. No Go-side direct-Postgres-write collector is being built in this pass. `web/`'s existing subprocess-spawn + JSON-parse + `insertFindings()` path (`web/lib/audit-executor.ts`, `web/lib/btg-runner.ts`, `web/lib/db.ts`) is the working, tested persistence path and stays authoritative.

## Goals

- Give each of the 12 analyzer files (all except `idle.go`) a pure, client-less `AnalyzeXFindings`/`AnalyzeXData`-shaped function — ported from Yomal's already-written version — with a real unit test exercising it. This is the one concrete capability this repo's analyzers are missing today: none of the 13 files' check logic has test coverage.
- Fix the two small independent bugs the investigation surfaced along the way, since they're in files this plan already touches:
  - `cmd/functions.go`: dead no-op "Client certificate mode" check (already flagged for removal by the file's own Yomal counterpart).
  - `cmd/cognitiveservices.go`: a `fmt.Sprintf` call with no format verbs (a real `go vet`-shaped issue, not just style — Yomal's copy already fixed it).
  - `cmd/publicip.go`: dead no-op IPv4/IPv6-version-tracking check.
- Reconcile `usage.go` and `usage_acr.go`'s small (19-line and 2-line) real differences from Yomal's copies (Task 14) — confirm which side's difference, if either, is worth keeping.

## Non-goals

- **No module/directory restructure.** Confirmed unnecessary — see Context.
- **No `vm`/`cdn` analyzers.** No existing check logic to port; writing new ones from scratch is a separate, future feature request, not this merge.
- **No Power Platform changes.** This repo's implementation is already ahead; Yomal's contributes nothing.
- **No `collect.go`, `seedadmin.go`, or any Postgres-writing Go code.** Confirmed with the user: `web/`'s existing ingestion path stays authoritative. If a standalone Go collector is wanted later, it needs its own spec — including, critically, deciding how it would write into *this* repo's actual `findings`/`audits` table shape (TEXT ids/timestamps, structured rows) rather than Yomal's `raw_data` JSONB-blob approach, which doesn't match how `web/`'s dashboard reads data today.
- **No `costanalysis.go` or `all.go` port**, despite having no Postgres dependency — out of scope for this pass since they weren't part of the original ask; can be scoped separately if wanted.
- **No `internal/extractors/` package created in this repo.** Yomal's cmd-vs-internal-extractors split isn't being adopted; ported functions land directly in this repo's existing single-file-per-analyzer files, matching this repo's own established convention.

## Per-file port list

| File | Function to port (from Yomal's `external/yomal/CLI Engine/cmd/<file>`) | Notes |
|---|---|---|
| `acr.go` | `AnalyzeACRFindings(registries []*armcontainerregistry.Registry) []ACRFinding` | Retype strings — source has mojibake in unrelated table-print code, not this function, but re-verify. |
| `appservice_traffic.go` | `ClassifyTrafficStatus(report *AppTrafficReport)` | Source file has mojibake in `printTable`, not this function — verify while copying. |
| `appserviceplan.go` | `AnalyzeASPsData(plans, planAppCount) ASPReport` | Skips the CPU/Memory metrics check (needs a live client) — same as this repo's non-ported behavior for that one check. |
| `cognitiveservices.go` | `AnalyzeCogServicesFindings(accounts []*armcognitiveservices.Account) []CognitiveServicesFinding` | Also: fix this repo's own `fmt.Sprintf` misuse in the "No Deployments" finding (no format verbs). |
| `cosmosdb.go` | `AnalyzeCosmosDBFindings(accounts []*armcosmos.DatabaseAccountGetResults) []CosmosDBFinding` | Skips SQL throughput check (needs live client). Source has mojibake — retype. |
| `functions.go` | `FunctionAppInput` struct + `AnalyzeFunctionsData([]FunctionAppInput) []FunctionsFinding` | Also: delete this repo's dead no-op "Client certificate mode" check. Source has mojibake — retype. |
| `iam.go` | `ResolvedAssignment` type + `AnalyzeIAMFindings(assignments []ResolvedAssignment, customRoles []CustomRole, _ string) []Finding` | — |
| `idle.go` | *(none — already a superset)* | Verify-only task. |
| `keyvault.go` | `AnalyzeKeyVaultFindings(vaults []*armkeyvault.Vault, _ time.Time) []KeyVaultFinding` | Skips expiry checks (need data-plane clients). |
| `nsg.go` | `AnalyzeNSGFindings(nsgs []*armnetwork.SecurityGroup) []NSGFinding` | Source has mojibake — retype. |
| `publicip.go` | exported testable wrapper (confirm exact name while reading source — reported as "the exported, testable form of `analyzePublicIPs`") | Also: delete this repo's dead no-op IPv4/IPv6-version check. |
| `resourcegroup.go` | `RGInput` struct + `AnalyzeRGFindings(rgs []RGInput) []RGFinding` | Source has mojibake — retype. |
| `storage.go` | `AnalyzeStorageFindings(accounts []*armstorage.Account) []StorageFinding` | Skips lifecycle-policy check (needs live client). |

Each ported function keeps its Yomal name and signature verbatim (so a future diff against Yomal stays legible) and is added as a new, additive function in the existing file — no existing function signature changes.
