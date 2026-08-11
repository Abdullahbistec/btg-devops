# Spec 11 — Extractor enrichment driven by real `data_gaps` (spec 10 Step A, round 1)

> Status: **design agreed, implementation in progress.** This is the first consumption of the
> `data_gaps` feedback loop built in spec 10: the deep-research agent's own reports of missing
> data (from the 2026-07-11 runs, audits `b9c6e53d` / `3e22f30c`) become concrete Go extractor
> changes. Read `10-deep-research-analysis.md` §6 first.

## Source: what the agent actually reported

11 of 78 scope-analyses reported `data_gaps`. Deduped and ranked by (frequency × how much it
blocks the deep-research playbook's Stage 2/3 output):

| Rank | Gap theme | Cited in | Blocks |
|---|---|---|---|
| 1 | App Service / Function App site details: `identity`, `publicNetworkAccess`, `minimumTlsVersion`, CORS, auth config | appservice, functions, keyvault, deep | Stage 3 attack chains (public app → managed identity → Key Vault) — cited as THE blocker |
| 2 | Storage per-container public-access level + lifecycle policy | storage, deep | Confirming actual (vs. merely permitted) public exposure |
| 3 | Site-level HTTP metrics all zero (contradicted by plan-level CPU + usage scope) | appservice, deep | Config × usage correlation (hidden waste) |
| 4 | `numberOfSites` = 0 on all 22 App Service Plans | appserviceplan | Idle-plan detection (agent had to cross-reference manually) |
| 5 | Diagnostic settings absent (Key Vault, Cognitive Services) | keyvault, cognitiveservices | Logging/audit checklist items |
| 6 | Resource types with cost but no extractor (Front Door, DNS, VNets, Log Analytics, NAT GW) | resourcegroup | "Empty resource group" conclusions unreliable |
| 7 | Cost history limited to 30 days | deep | Trend judgment ("is this spend new or longstanding?") |
| 8 | Cognitive Services call-volume metrics | cognitiveservices | Tier-fit/unused-account checks (deferred, low frequency) |
| 9 | Cosmos per-database RU / partition keys | cosmosdb | Deferred — accounts are serverless; agent itself noted waste analysis inapplicable |

Not fixable by extractors (recorded as the Version B / permissions backlog, spec 10 §6):
principal-ID → display-name resolution (needs MS Graph directory read), sign-in/activity logs,
Key Vault secret metadata (needs data-plane vault access), ACR vulnerability scans (needs
Defender for Cloud enabled).

## Design per fix (this round implements ranks 1–7)

### 1. App Service + Functions: per-site config & auth enrichment
Files: `internal/extractors/appservice.go`, `internal/extractors/functions.go`.

Per site (same pattern as the existing per-app metrics merge):
- `WebAppsClient.GetConfiguration(rg, name)` → keep `minTlsVersion`, `ftpsState`, `http20Enabled`,
  `cors.allowedOrigins`, `ipSecurityRestrictions` (name/action/priority/ipAddress only),
  `scmIpSecurityRestrictions` summary.
- `WebAppsClient.GetAuthSettingsV2(rg, name)` → keep ONLY `platform.enabled`,
  `globalValidation.unauthenticatedClientAction`, and the list of enabled identity-provider names.
  **Never** collect client secrets/settings values.
- `WebAppsClient.ListApplicationSettings(rg, name)` → keep setting **names only**, never values,
  plus a derived `keyvault_reference_count` (settings whose value starts with
  `@Microsoft.KeyVault`). Names alone let the agent spot plaintext-credential smells
  (e.g. `DB_PASSWORD` present but no Key Vault reference) without ever storing a secret.
- The site envelope's `identity` block (principalId, type) is already returned by the list API —
  verify it survives `CleanResource` and appears in output; it was reported absent.
- New entry fields: `security_config` (json), `auth_config` (json), `app_setting_names` ([]string),
  `keyvault_reference_count` (int).

Payload: ~0.5–1 KB per app × ~28 sites — negligible. API calls: +3 per site (~84 calls, fine).
Failures per-site are recorded as `"<field>_error": "<msg>"` instead of silently omitted.

### 2. Storage: containers + lifecycle policy
File: `internal/extractors/storage.go`.

Per account:
- `BlobContainersClient.NewListPager(rg, account)` → per container keep only: name,
  `publicAccess`, `lastModifiedTime`, `deleted`. New field `containers` on the account entry,
  plus `containers_public` (count with publicAccess != None) so the agent can rank at a glance.
- `ManagementPoliciesClient.Get(rg, account, "default")` → store the policy rules JSON as
  `lifecycle_policy`; a 404 stores `lifecycle_policy: null` (meaning: confirmed absent — the
  distinction the agent needs vs. "not collected").

Payload: bounded — cap stored containers at 50 per account (store `total_containers` alongside).

### 3. Fix site-level HTTP metrics (bug, not enrichment)
File: `internal/extractors/appservice.go` (and the same call in `functions.go` if present).

Root cause: `MetricsClient.List` is called with a 30-day timespan and **no `Interval`**, and the
error is silently swallowed (`if err == nil`), leaving all-zero metrics. The working usage
extractor (`usage.go:107`) passes `Interval: "P1D"`. Fix: pass `Interval: strPtr("P1D")`, and on
error store `metrics_error` in the entry instead of fake zeros — fake zeros are worse than an
honest gap (the agent explicitly distrusted this field, correctly).

### 4. App Service Plan: real hosted-site count
File: `internal/extractors/appserviceplan.go`.

ARM's plan list returns `numberOfSites: 0` unreliably. Fix at collection time: after listing
plans, list all sites once (web + function apps, already fetched by their own extractors — but
keep this extractor self-contained: one `WebAppsClient.NewListPager` pass), group by
`serverFarmId` (case-insensitive — ARM IDs vary in casing), and inject `sites_hosted` (int) and
`hosted_site_names` ([]string, cap 20) into each plan's JSON. Keep the raw `numberOfSites` as-is
for comparison.

### 5. Diagnostic settings for Key Vault + Cognitive Services
Files: `internal/extractors/keyvault.go`, `internal/extractors/cognitiveservices.go`.

Per resource: `armmonitor.DiagnosticSettingsClient.NewListPager(resourceID)` → store
`diagnostic_settings`: for each setting, name + enabled log category names + whether it targets a
Log Analytics workspace/storage/event hub. Empty list stores `[]` (confirmed none — again the
"confirmed absent vs. not collected" distinction).

### 6. Generic subscription inventory (new extractor)
New file: `internal/extractors/inventory.go`, new key `inventory` in `raw_data`.

`armresources.Client.NewListPager` (already a go.mod dependency) → every resource's
name/type/location/resourceGroup/tags (no properties — envelope only). Output:
`{ total_resources, by_type: {"microsoft.network/dnszones": 12, ...}, resources: [...] }`.
This closes the "cost data shows Front Door/DNS/VNet but no extractor sees them" hole in one
cheap call, and future-proofs the resource-group emptiness analysis. Payload: envelope-only,
even hundreds of resources stay small. Cap `resources` at 500 with `truncated: true` flag.

### 7. Cost history: 30 → 90 days
File: `internal/extractors/cost.go`.

Widen `QueryTimePeriod` to 90 days, keep daily granularity (Cost Management allows ~1 year daily).
Downstream consumers read named rows, so no schema change — but verify the dashboard's cost charts
(period_from/period_to are already fields) render sensibly with the longer window.

## Wiring & conventions

- `cmd/collect.go`: add the `inventory` extractor to the collection sequence; everything else
  hides inside existing extractors — no orchestration change.
- All new per-resource sub-calls are best-effort: a failure records an `*_error` string field on
  that entry and continues. A single bad resource must never fail the whole audit.
- All new JSON passes through `CleanResource`/manual field selection consistent with cleaner.go.
- Tests: table-driven unit tests for the new pure functions (serverFarmId grouping,
  container-field reduction, app-setting name extraction + Key Vault reference counting),
  following `cleaner_test.go`. SDK calls themselves are not unit-tested (no fakes in this repo).

## Acceptance (closes the loop, spec 10 §6)

1. Fresh audit stores the new fields in `audits.raw_data` (spot-check via dashboard Raw Data
   section or SQL).
2. The next deep-research run's `data_gaps` no longer contains gap themes 1–7; expected leftovers
   are only the Version B items (directory lookup, activity logs, vault data-plane, Defender).
3. The playbook checklists in `spec/agent/deep-research-playbook.md` get a short addendum telling
   the agent the new fields exist (containers, auth_config, sites_hosted, inventory, 90-day cost)
   so it actually uses them.
