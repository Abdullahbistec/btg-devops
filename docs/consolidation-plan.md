# Consolidation Plan: Azure + Power Platform + Hetzner Governance Platform

**Status:** Read-only analysis. No source files were modified to produce this document.
**Scope:** `cmd/` (Go CLI), `provider/` (Go), and `web/` (Next.js dashboard) as they exist on branch `abd-production`.

## 0. Framing and a correction to scope

The two codebases being consolidated:

- **13 Azure analyzers**, authored by Yomal — `acr`, `appservice-traffic`, `appserviceplan`,
  `cognitiveservices`, `cosmosdb`, `functions`, `iam`, `keyvault`, `nsg`, `publicip`,
  `resourcegroup`, `sp-expiry`, `storage`.
- **5 Power Platform analyzers**, authored by you — `powerplatform`, `pp-environments`,
  `pp-apps`, `pp-flows`, `pp-powerbi`.

Two things have already happened on this branch, ahead of this plan, and the rest of this
document is written against that reality rather than a blank slate:

1. **A 14th Azure analyzer, `idle`, was added** (waste/idle-resource detection) after Yomal's
   original 13. It follows his exact conventions and is treated as part of the "Azure set" for
   inventory purposes, but is called out separately wherever the count of 13 vs. 14 matters.
2. **A `provider` package and a first Hetzner slice already exist.** `provider/analyzer.go` and
   `provider/registry.go` define a working `Analyzer` interface and an N-way registry
   (`map[string][]Analyzer` keyed by provider name), and all 14 Azure + 5 PP analyzers already
   register against it via thin adapters. Five read-only Hetzner analyzers
   (`hetzner-servers`, `hetzner-volumes`, `hetzner-floatingips`, `hetzner-firewalls`,
   `hetzner-certificates`) are already built the same way, and the web dashboard already has a
   working three-way (Azure / Power Platform / Hetzner / All) provider filter.

Section 6 ("Hetzner proposal") is written as a **gap analysis against what's already shipped**,
not a from-scratch design — pretending Hetzner doesn't exist yet would just contradict the repo.
Section 4 ("target architecture") likewise describes what's *already true* and calls out the one
piece of the old two-provider design that hasn't caught up yet (`analyze all`).

---

## 1. Inventory

One row per analyzer/command. "What it checks" is a compressed list of finding categories, not
full descriptions — see the per-file detail folded into sections 2–3 for trigger conditions.
"Pillar(s)" lists every governance pillar that analyzer's checks touch, in the order they appear
in the code, since almost none of these analyzers are single-pillar.

| Provider | Command | Author | What it checks | Pillar(s) |
|---|---|---|---|---|
| Azure | `acr` | Yomal | Admin account enabled; public network access; no private endpoint; retention policy disabled/missing; no CMK; content trust disabled; export policy enabled; Basic SKU; no zone redundancy; no geo-replication | security, cost, best-practice |
| Azure | `appservice-traffic` | Yomal | Idle/unused app (0 requests 14d); low traffic; high 5xx rate | cost, best-practice |
| Azure | `appserviceplan` | Yomal | Empty plan; over-provisioned (low CPU/mem util); SKU right-sizing; no SLA (Free/Shared tier in use); no autoscale | cost, best-practice |
| Azure | `cognitiveservices` | Yomal | Public network access; no private endpoint; no managed identity; no CMK; no network rules / permissive default; outbound not restricted; local auth enabled; no deployments; provisioned capacity; provisioning failed; Free tier | security, cost, stale, best-practice |
| Azure | `cosmosdb` | Yomal | Public network access; no firewall/private endpoint; infrequent/short backups; periodic (not continuous) backup; strong consistency; multi-region write disabled; single region; auto-failover disabled; wildcard CORS; key-based auth enabled; manual/high-autoscale throughput (DB + container); analytical store disabled | security, cost, stale, best-practice |
| Azure | `functions` | Yomal | Outdated runtime/extension version; HTTPS not enforced; no managed identity; always-on disabled; Consumption plan noted; Premium without VNET; outdated TLS; not running; remote debugging enabled; FTP allowed | security, stale, best-practice |
| Azure | `iam` | Yomal | Overprivileged principal (Owner/Contributor at sub scope); SP overprivileged; too many Owners; orphaned assignment; duplicate assignment; direct user assignment; classic admin role in use; overly broad custom role | security, stale, best-practice |
| Azure | `idle` *(added after Yomal's 13)* | You | Zero-usage / idle resource by type (public IP, app plan, storage, Cosmos DB, Key Vault, ACR, App Service, Functions, Cognitive Services); over-provisioned (high/medium waste score) | cost |
| Azure | `keyvault` | Yomal | Access policies not RBAC; soft-delete disabled; no purge protection; unrestricted network access; overly broad key/secret permissions; expired/expiring key; expired/expiring secret; no private endpoints; short retention | security, stale, best-practice |
| Azure | `nsg` | Yomal | Unassociated NSG; any-any allow rule; management port open to internet; other internet-facing rule | security, stale |
| Azure | `publicip` | Yomal | Unused/unattached IP; Basic SKU (retiring); Standard+Dynamic misconfig; no DDoS settings; no availability zones | cost, security, best-practice |
| Azure | `resourcegroup` | Yomal | Empty resource group; tag compliance; naming convention; missing lock | stale, best-practice |
| Azure | `sp-expiry` | Yomal | Expired secret/certificate; expiring within 30/60/90 days | security |
| Azure | `storage` | Yomal | HTTPS not enforced; blob public access enabled; weak TLS; unrestricted network access; shared key access enabled; no lifecycle policy; no infrastructure encryption | security, cost |
| Power Platform | `powerplatform` | You | Suspended license; license expiring; zero-usage seats; severe/moderate/minor license waste; trial license in active use | cost, stale, best-practice |
| Power Platform | `pp-environments` | You | No DLP policy; weak DLP (HTTP not blocked); permissive default connector class; default-environment risk; trial environment; disabled environment; expiring soon; dormant Dataverse; not a Managed Environment; environment sprawl | security, cost, stale, best-practice |
| Power Platform | `pp-apps` | You | Stale app (180/365d); app in default environment; premium app with no description; broadly shared app; custom connector in use; orphaned app; unpublished changes; wide group sharing | stale, security, cost, best-practice |
| Power Platform | `pp-flows` | You | Suspended flow; stopped flow; stale flow; flow in default environment; no owner; broadly shared flow; high-risk connector; broad-access connector; premium connector | best-practice, stale, security, cost |
| Power Platform | `pp-powerbi` | You | Deleted workspace; orphaned (no admin) workspace; empty workspace; content in personal workspace; large workspace on shared capacity; datasets without refresh | stale, security, cost |
| Hetzner *(already built)* | `hetzner-servers` | This session | Stopped server (still billed); no firewall attached; deprecated image; backups disabled | cost, security, best-practice |
| Hetzner *(already built)* | `hetzner-volumes` | This session | Unattached volume (severity escalates with age) | cost |
| Hetzner *(already built)* | `hetzner-floatingips` | This session | Unassigned floating IP | cost |
| Hetzner *(already built)* | `hetzner-firewalls` | This session | Sensitive port open to internet; other port open to internet; unused firewall config | security, best-practice |
| Hetzner *(already built)* | `hetzner-certificates` | This session | Expired certificate; expiring 30/60/90 days; issuance failed; renewal failed | security |

**24 analyzers total today**: 14 Azure + 5 PP + 5 Hetzner.

---

## 2. Duplication

Ranked roughly by how much it actually costs you today, not by line count alone.

### 2.1 Dual-language command lists (highest ongoing cost)

Every analyzer's name is hand-maintained in **at least two places, in two languages**:
`cmd/analyze_all.go` (`allAzureCmds`, `allPPCmds`, `allServiceLabels`) and
`web/lib/btg-commands.ts` (`AZURE_COMMANDS`, `PP_COMMANDS`, `HETZNER_COMMANDS`,
`PP_SERVICE_LABELS`, `HETZNER_SERVICE_LABELS`). Adding one analyzer today means touching the new
analyzer's own file, `analyze_all.go`'s list, `btg-commands.ts`, and (per §2.2) a resource-field
guess list on both sides. This is the single most expensive duplication in the repo because it's
the one that silently drifts — nothing fails loudly when the two lists disagree, findings just
go missing or get mis-scoped.

### 2.2 Two independent "guess the resource name" heuristics

`cmd/analyze_all.go`'s `extractFindings()` + `resourceFields` priority list (Go) and
`web/lib/btg-runner.ts`'s `extractResource()` (TypeScript) both do the same job — pick the first
non-empty field from a hand-ordered list of known field names per analyzer — completely
independently. They have already drifted once (documented: `pp-environments`' `Resource` field
came back empty via one path but not the other). Hetzner's three field names
(`server_name`/`volume_name`/`firewall_name`/`cert_name`/`name`) were added to the TS list this
session but have **no Go-side equivalent**, because `analyze_all.go` still only knows about
`allAzureCmds`/`allPPCmds` — Hetzner literally cannot appear in `analyze all` output today.

### 2.3 REST-fetch-with-bearer-token helper, built twice

`cmd/pp_helpers.go`'s `ppFetch(ctx, token, url, out)` and `cmd/hetzner_helpers.go`'s
`hetznerFetch(ctx, token, url, out)` are structurally identical: same signature, same
`Authorization: Bearer` + `Accept: application/json` headers, same `fmt.Errorf("HTTP %d: %s", ...)`
non-200 handling with a 400-character body truncation. `hetznerFetch` was written this session as
a deliberate copy of `ppFetch`'s shape (documented in its own comment) specifically *because*
duplicating it was faster than generalizing it at the time. This is genuine, easy, low-risk
duplication to merge.

### 2.4 Date-math helpers, built three times

`ppDaysSince` (multi-format, because Graph/BAP timestamps are inconsistently formatted),
`hetznerDaysSince`, and `hetznerDaysUntil` (both single-format, since Hetzner is always strict
RFC3339) all do the same subtraction-and-truncate arithmetic. `hetznerDaysSince`/`hetznerDaysUntil`
are a strict subset of what `ppDaysSince`'s format list already handles.

### 2.5 Expiry-ladder evaluation logic, built twice

`sp_expiry.go`'s `evalCredExpiry` and `hetzner_certificates.go`'s `hetznerEvalCertExpiry` implement
the identical four-tier severity ladder (expired → Critical, ≤30d → Critical, ≤60d → Warning,
≤90d → Info) against different input shapes. Same algorithm, same thresholds, same severity
mapping, written twice five months apart by two different authors converging on the same design
independently — a strong signal this belongs in one shared function.

### 2.6 "Flag overrides env var" config resolvers, built three times (shape, not values)

`getSubscriptionID()`/`flagSubscriptionID` (Azure ARM), `getTenantID()`/`flagTenantID`
(Azure AD, shared by Azure+PP), `getHetznerToken()`/`flagHetznerToken` (Hetzner) — three
independent one-line functions with the identical `if flag != "" { return flag }; return
os.Getenv(...)` shape. The *values* they resolve are genuinely provider-specific (see §3), but
the *pattern* is copy-pasted three times.

### 2.7 Table-printing boilerplate — largest by line count, lowest priority

Every one of the 24 `printXxxTable` functions hand-rolls the same shell: a summary block, a
severity-count line (`Critical: %d | Warning: %d | Info: %d`), a `text/tabwriter` table with a
header/separator pair, and a "RECOMMENDATIONS" section using the same
🔴/🟡/ℹ️ icon-by-severity logic. Roughly 800–1,200 lines of near-identical scaffolding across 24
files, differing only in which columns/fields get interpolated. This is the biggest duplicated
line count in the repo but the lowest-risk and lowest-urgency to fix — it's presentation code with
zero effect on findings correctness, and it's the same across Yomal's and your code already (see
§3, "error handling"/"logging" — this convention is one of the few things both authors already
converged on independently).

### 2.8 Findings-table scope filtering as a service-label heuristic, not a schema fact

`web/app/api/dashboard/route.ts` and `web/app/api/findings/route.ts` both scope by provider via
`service IN (...)`/`NOT IN (...)` against `PP_SERVICE_LABELS`/`HETZNER_SERVICE_LABELS` sets — the
same heuristic duplicated across two route files, standing in for a `provider` column that
doesn't exist yet (see §5). This was already partially generalized this session (Azure's clause
became an explicit `NOT IN (PP) AND NOT IN (Hetzner)` rather than a binary `NOT IN (PP)`), but
it's still string-matching, not a stored fact.

### 2.9 What is *not* duplicated, worth naming explicitly

The `Severity` type, error-message phrasing, and stderr/stdout logging convention are each
defined **once** and shared correctly (Go same-package visibility for `Severity`; convention-only
for logging/errors, but a convention both authors already follow identically). The SQLite findings
store is a single implementation already shared by every provider. These are not consolidation
targets — they're already unified and should be left alone.

---

## 3. Which pattern wins

| Concern | Yomal's (Azure) pattern | Your (PP) pattern | Hetzner (this session) | Recommendation | Why |
|---|---|---|---|---|---|
| Analyzer interface | Implicit (`runXxx` shape only) until this session | Same | Native, built to the interface from day one | **`provider.Analyzer`** (already built — `Name() string` + a run method that returns a slice of findings and an error) | This isn't a two-way choice — it's a third abstraction both existing codebases already converged into via thin adapters, with zero changes to either author's detection logic. No further decision needed; formalize it as final. |
| Finding struct | 14 distinct domain-specific structs | 5 distinct domain-specific structs | Same, 5 more | **Two-tier: keep each analyzer's own domain struct internally; `provider.Finding` only at the interchange boundary** | Forcing one universal struct onto detection code would lose real fields (`Environment`, `Datacenter`, `DaysRemaining`, etc.) that make each analyzer's own table/JSON output useful. The conversion functions (`xxxFindingsToProvider`) that already exist for all 24 analyzers are the right — and only necessary — seam. |
| Severity | 3-level (`Critical`/`Warning`/`Info`), defined once in `iam.go` | Same 3-level type, reused as-is | Same 3-level type, reused as-is | **Neither wins outright — introduce the 4-level canonical scale only at the existing `xxxFindingsToProvider` seam**, leave all 24 analyzers' internal `Severity` untouched | No analyzer anywhere in the repo has ever implemented a 4th level; there's nothing to compare. Doing the remap at the one boundary that already exists avoids touching 24 files' internal detection logic and confines the highest-blast-radius change in this whole plan to one already-isolated layer (see §5, §7 Phase 6). |
| Config / credentials | 4-field Azure AD service principal (`AZURE_TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET`/`SUBSCRIPTION_ID`), flag-overrides-env resolver | Reuses the *same* 4-field shape, with an optional `BTG_PP_*` override — **but that override is resolved only in the TypeScript web layer** (`getPPCredentials` in `btg-runner.ts`), not in the Go CLI itself | Single opaque token (`HCLOUD_TOKEN`), same flag-overrides-env resolver shape | **Keep the flag-overrides-env resolver shape (Yomal's) for every provider; do not force one credential struct.** Fix the PP asymmetry by adding the `BTG_PP_*` override inside the Go CLI too | The 4-field AD-principal shape and Hetzner's 1-field token are genuinely different auth models — collapsing them into one struct (as `web/lib/btg-runner.ts`'s `Credentials` type currently tries to do for Azure+PP) is the wrong abstraction, not a missing one. The resolver *pattern*, though, generalizes cleanly and already has 3 independent, correct implementations — formalize it. Today, running `btg-devops analyze pp-flows` directly from a terminal (bypassing the web layer) silently cannot honor `BTG_PP_*` — worth fixing for consistency. |
| Auth mechanics (HTTP/token) | Direct Azure SDK client construction (17 `arm*` packages) | Raw bearer-token REST via `ppFetch`/`ppToken` | Raw bearer-token REST via `hetznerFetch`/`getHetznerToken` (a deliberate copy of PP's shape) | **SDK clients for Azure (keep, don't touch — no viable alternative and it's well-tested); merge `ppFetch`+`hetznerFetch` into one shared REST-fetch helper for everything else** | Azure's SDK-vs-REST split isn't a style choice, it's dictated by what Microsoft ships. Within the REST-based providers, PP's `ppFetch` is the proven implementation (5 analyzers, in production); Hetzner's is a byte-for-byte copy under a new name. Merge into one file, parameterized by nothing provider-specific. |
| Storage | — | — | — | **`web/lib/db.ts` as-is, single findings table, add one column (§5)** | Only one storage implementation exists; there is nothing to compare. The one real gap (`subscriptions` table is Azure-AD-shaped, doesn't fit Hetzner's single-token model) is already worked around this session by reading `HCLOUD_TOKEN` from process env instead of the DB — recommend formalizing that as a deliberate additive `credential_sets` table later (§7 Phase 7), not reshaping `subscriptions`. |
| Error handling | `fmt.Errorf("...: %w", err)` wrapping, actionable "set --flag or ENV_VAR" messages | Identical style | Identical style | **Already unified — no decision needed** | Both authors converged on the same convention independently (most likely because PP's code was modeled on Azure's when written). Hetzner matched it deliberately. Formalize as house style; nothing to change. |
| Logging | stderr for progress (`Fetching X...`), stdout reserved for table/JSON output | Identical | Identical | **Already unified — no decision needed** | Same as above. |
| Testing | Pure-logic, table-driven-where-branchy (`idle_test.go`, `usage_test.go`); no adapter-conversion tests until this session added a 3-of-14 sample | Same pure-logic style (`pp_test.go`); this session added exhaustive 5-of-5 adapter-conversion tests | Same pure-logic style, **plus a new pattern**: `httptest.Server`-backed fixture tests of the raw-HTTP fetch layer (`hetzner_fetch_test.go`) | **Keep the pure-logic table-driven style as house style (universal, zero disagreement). Adopt Hetzner's `httptest` fixture pattern as the new standard for any REST-fetch layer going forward. Backfill Azure's adapter-conversion coverage from 3-of-14 to exhaustive, matching PP/Hetzner's 5-of-5.** | Azure's sample coverage predates the exhaustive-coverage precedent PP and Hetzner both now demonstrate is cheap enough to do fully. The `httptest` pattern is genuinely new (neither prior codebase had it) because Hetzner's fetch helper was unverified/new, unlike Azure's Microsoft-maintained SDK or PP's already-production-proven `ppFetch`. |

---

## 4. Target architecture

Most of this section describes what's **already built**, not a new proposal — the gap is called
out explicitly at the end.

**Package layout (as-is, recommended to stay as-is):** one flat `cmd/` package holding all 24
analyzer files plus shared helpers (`pp_helpers.go`, `hetzner_helpers.go`), and a standalone
`provider/` package with zero dependency on `cmd/` (`cmd` imports `provider`, never the reverse).
No `internal/`, no per-provider subpackage — this matches Yomal's original flat structure and
there's no evidence a deeper split would pay for itself given how small each analyzer file is.

**Registry (as-is):** one `map[string][]Analyzer` keyed by provider name (`"azure"`,
`"powerplatform"`, `"hetzner"`), a single `Register(provider, analyzer)` call site pattern
(one line per analyzer's own `init()`), `Analyzers(provider)`/`Providers()`/`Run(ctx, provider)`
as the read/execute surface. Already N-way — a fourth provider needs zero registry changes.

**CLI surface (mostly as-is, one gap):**
- `analyze <leaf-command>` — 24 today, unchanged naming, one file each. No change.
- `analyze azure` / `analyze hetzner` — provider-wide, in-process, via `provider.Run(ctx, name)`.
  Already built for these two. Note the naming constraint this creates: a provider-wide command
  can only be named after its provider key if no leaf command already claims that name — this is
  exactly why Power Platform has **no** provider-wide `analyze powerplatform` command (the leaf
  command `powerplatform` already owns that name). This is a permanent constraint of the flat
  command namespace, not a temporary gap — document it as such rather than trying to route around
  it with a different name.
- `analyze all --scope <provider>` — **still the pre-`provider`-package design**: a hardcoded
  `switch` over `"azure"`/`"pp"`/`"all"` shelling out to the built binary once per command via
  `os/exec`, parsing each command's stdout JSON back into a `UnifiedFinding` via the
  `extractFindings()`/`resourceFields` heuristic from §2.2. It doesn't know Hetzner exists at all.
  This is the one piece of "target architecture" not yet realized: rewrite it to iterate
  `provider.Providers()` and call `provider.Run(ctx, name)` in-process, for every registered
  provider, with `--scope` reading directly from whatever provider names are actually registered
  instead of a fixed two-case switch. This one change deletes the Go-side half of the
  resource-extraction duplication in §2.2 outright (in-process calls already return typed
  `[]provider.Finding` — no JSON round-trip, no field-guessing) and makes `analyze all` pick up
  any future provider for free. See §7 Phase 1.

---

## 5. Unified findings schema

**Add one column, additively, following the exact pattern already used five times in
`web/lib/db.ts`** (`ALTER TABLE ... ADD COLUMN`, wrapped in try/catch):

```
provider TEXT DEFAULT ''
```

Backfill existing rows once, from the same service-label sets already used for scope filtering
today (`PP_SERVICE_LABELS` → `'powerplatform'`, `HETZNER_SERVICE_LABELS` → `'hetzner'`, everything
else → `'azure'`). After backfill, every future insert populates `provider` directly from
`provider.Finding.Provider` (already a field on that struct today) instead of re-deriving it from
`service` at query time — this is what actually retires the §2.8 heuristic, not just formalizes it.

**Severity: 3 levels → 4 levels, canonical scale `critical`/`high`/`medium`/`low`:**

| Existing value | Canonical value | Rationale |
|---|---|---|
| `Critical` | `critical` | Direct |
| `Warning` | `high` | Preserves "needs attention soon" meaning |
| *(not used by any analyzer today)* | `medium` | Reserved for checks that genuinely sit between `Warning` and `Info` — none of the 24 existing analyzers need it today; future ones (e.g. a Hetzner load-balancer check) can use it |
| `Info` | `low` | Direct |

This mapping is unchanged from an earlier, already-reviewed proposal on this branch — carried
forward here because nothing about it has been invalidated by the work done since. As stated in
§3, the remap happens **only** inside each analyzer's existing `xxxFindingsToProvider` conversion
function (24 call sites, one per analyzer, all of which already exist) — not inside detection
logic, not inside the internal `Severity` type. The DB column's value space and every
`provider.Finding.Severity` value change; nothing else does.

**What does not change:** `service`, `resource`, `environment`, `category`, `description`,
`recommendation`, `owner` stay exactly as they are — already provider-neutral plain strings, and
Hetzner findings already fit this shape without modification (confirmed: all 5 Hetzner analyzers
already populate these fields identically to Azure/PP).

---

## 6. Hetzner: coverage today vs. remaining gaps

Five read-only analyzers already ship (§1). This section maps them against the four pillars and
flags what's still open — reusing the same API-surface research from before, now cross-checked
against what's actually implemented.

| Pillar | Shipped today | Endpoint(s) used | Still open (not built) | Endpoint(s) needed | Notes |
|---|---|---|---|---|---|
| Cost waste | Stopped server still billed; unattached volume (age-escalated); unassigned floating IP | `GET /servers`, `GET /volumes`, `GET /floating_ips` | Low-CPU-utilization server; old/unused snapshot | `GET /servers/{id}/metrics?type=cpu`; `GET /images?type=snapshot` | Metrics-based idle detection was deliberately deferred this session — Hetzner's metrics API has much shorter retention than Azure Monitor, so any such check should ship labeled lower-confidence and with a shorter lookback window than Azure's `idle` command uses. |
| Security gaps | No firewall attached; sensitive/other port open to internet (rule-level) | `GET /servers` (`public_net.firewalls`), `GET /firewalls` | Load Balancer with no health check configured | `GET /load_balancers` | Straightforward, single list endpoint, same shape as existing checks — good next candidate. |
| Stale resources | Long-unattached volume (age-based severity) | `GET /volumes` (`created` field) | SSH Keys not attached to any server; old unused snapshots | — | **SSH key check is not cleanly expressible with the current API and should be dropped or redefined**, not carried forward as-is: Hetzner's SSH key object has no persistent "attached servers" field after boot-time key injection, so "not attached" can't be queried directly — only "never used at creation" could be approximated, and even that isn't exposed. Snapshot staleness (age-only, `GET /images?type=snapshot`) is buildable the same way volumes were. |
| Best-practice violations | Deprecated image; backups disabled; unused firewall config; **certificate expiry (30/60/90d ladder, direct parallel to `sp-expiry`)** | `GET /servers`, `GET /firewalls`, `GET /certificates` | Load Balancer missing health check (also fits here) | `GET /load_balancers` | Certificate expiry was originally scoped as a "still open" item in earlier planning and has since shipped — remove it from any future gap list. |

**Confirmed still not expressible at all, regardless of which pillar:**
- **No per-resource cost-history API.** Only a static `GET /pricing` list-price endpoint exists —
  every cost-waste finding (already true for the shipped `hetzner-volumes` check, which uses a
  static €/GB/month constant) must report resource-count/size/list-price terms, never an actual
  historical spend trend.
- **No IAM/RBAC equivalent.** Hetzner API tokens are project-scoped with a single read/write
  permission bit — there's no per-resource role-assignment model to audit, so an `iam`-equivalent
  Hetzner analyzer has no real target and should stay dropped rather than forced into existence
  for symmetry with Azure's `iam`.

---

## 7. Refactor sequence

Ordered so each phase is independently shippable and revertable; a `git revert` of any single
phase doesn't require reverting any other. Phase 0 is already done and included only so the
sequence reads as a complete history rather than skipping a step.

| Phase | Work | Breaks existing tests? | What needs rewriting |
|---|---|---|---|
| **0 (done)** | `provider.Analyzer` interface + registry; adapters for all 14 Azure + 5 PP analyzers; `analyze azure`/`analyze hetzner` provider-wide commands; first 5 read-only Hetzner analyzers; N-way scope filter in the two dashboard API routes | No | Already landed this session |
| **1** | Rewrite `analyze_all.go` to iterate `provider.Providers()` and call `provider.Run(ctx, name)` in-process instead of `os/exec`-per-command; delete `allAzureCmds`/`allPPCmds`/`extractFindings`/`resourceFields` | No existing test asserts `analyze all`'s exact JSON shape today, so no test rewrite — but real CLI *behavior* changes (subprocess → in-process), so the acceptance check is a byte-for-byte `analyze all --output json` diff before/after, for `--scope azure`, `--scope pp`, and (newly possible) `--scope hetzner` | `cmd/analyze_all.go` only |
| **2** | Add `provider` column to `findings` (additive `ALTER TABLE`), one-time backfill from existing service-label sets | No — column is unread until Phase 6 populates/uses it meaningfully | `web/lib/db.ts` (schema), one-off backfill script |
| **3** | Merge `ppFetch`+`hetznerFetch` → one shared REST-fetch helper; merge `ppDaysSince`+`hetznerDaysSince`+`hetznerDaysUntil` → one shared pair; merge `evalCredExpiry`+`hetznerEvalCertExpiry` → one shared expiry-ladder function | Yes, mechanically — every test calling the old function names directly (`TestPPDaysSince_*`, `TestHetznerFetch_*`, `TestHetznerDaysSince_*`/`TestHetznerDaysUntil_*`, `sp_expiry`'s and `hetzner_certificates`' expiry tests) needs an import/rename update. Pure rename, no logic change, so low risk despite touching ~15 test functions | `cmd/pp_helpers.go`, `cmd/hetzner_helpers.go`, `cmd/sp_expiry.go`, `cmd/hetzner_certificates.go`, plus the test files above |
| **4** | Move PP's `BTG_PP_*` credential-override resolution from `web/lib/btg-runner.ts` into the Go CLI itself, alongside `getTenantID()` | No | `cmd/powerplatform.go` (or a shared config file), `web/lib/btg-runner.ts` (can then simplify, no longer the only place this logic exists) |
| **5** | Extract the shared `printXxxTable` scaffold (summary block, severity-count line, tabwriter table, recommendations-with-icon loop) into one parameterized helper; migrate all 24 print functions to call it | No, if done as a pure mechanical refactor — acceptance check is an exact stdout byte-diff per command (table and JSON) across all 24 commands, before/after | All 24 analyzer files' `printXxxTable` functions |
| **6** | Severity 3-level → 4-level canonical scale, applied *only* inside the 24 existing `xxxFindingsToProvider` conversion functions | **Yes — the widest blast radius in this plan.** Every one of `provider_adapter_test.go`'s ~15+ exhaustive conversion tests currently asserts the old value (e.g. `provider.Critical`) and must be updated to the new canonical token. The TS dashboard's hardcoded `'Critical'`/`'Warning'`/`'Info'` string comparisons (`SEV_COLOR` map, severity filter tabs, any remaining `analyze all` consumers) must change in the **same** phase, not a follow-up — a split would leave the dashboard unable to recognize newly-4-level DB values for however long the gap lasts | `cmd/*_test.go` (all `FindingsToProvider` tests), every `xxxFindingsToProvider` function, `web/app/dashboard/page.tsx`'s severity-keyed maps/filters, any other TS file with a literal `'Critical'`/`'Warning'`/`'Info'` comparison (grep-and-verify pass required before/after) |
| **7** | Formalize Hetzner credentials as an additive `credential_sets`-style table (or similar), replacing the current "read `HCLOUD_TOKEN` from process env, require at least one dummy Azure `subscriptions` row to exist" workaround | No — additive table, opt-in read path | `web/lib/db.ts`, `web/lib/audit-executor.ts`, `web/lib/btg-runner.ts` |
| **8** | Remaining Hetzner analyzers from §6's gap list (Load Balancer health checks, snapshot staleness; SSH-key check dropped or redefined per §6) | No — additive, one PR per check, same precedent as this session's build | New `cmd/hetzner_*.go` files only |

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Severity 3→4 migration (Phase 6) breaks a hardcoded `'Critical'`/`'Warning'`/`'Info'` string comparison somewhere in the TS dashboard that a grep pass missed | High if attempted casually | Exhaustive grep-for-literal-strings pass immediately before and after Phase 6, specifically; land Go-side and TS-side changes in the same commit/PR, never split |
| `analyze_all.go` rewrite (Phase 1) subtly changes output ordering, an omitted command, or error-message text that some downstream consumer depends on | Medium | Byte-for-byte JSON diff of `analyze all --output json` before/after, for `--scope azure`, `--scope pp`, and `--scope hetzner`, as the hard acceptance gate before merging |
| Print-scaffold extraction (Phase 5) introduces a subtle formatting difference (column width, spacing, icon logic) across 24 call sites during a tedious mechanical refactor | Medium (tedium breeds copy-paste mistakes, not logic errors) | Exact stdout byte-diff per command (table + JSON) as the acceptance check, not visual review |
| Merging `ppFetch`+`hetznerFetch` (Phase 3) accidentally changes pagination or timeout behavior for one of PP's 5 existing callers, which have been in production longer than Hetzner's | Low–Medium | Keep the merged helper's behavior byte-for-byte identical to `ppFetch`'s (the proven implementation, per §3) rather than `hetznerFetch`'s; re-run all 5 PP analyzers' existing tests plus the new `httptest` fixture tests as the gate |
| Hetzner's lack of a cost-history API produces misleadingly precise-looking waste figures if a future contributor forgets the constraint from §6 | Certain unless documented | Keep reporting waste in resource-count/size + static list-price terms only, and say so explicitly in each finding's description (already true for the shipped `hetzner-volumes` check — hold future Hetzner cost checks to the same bar) |
| Hetzner's metrics API (once a low-CPU-utilization check is eventually built, §6/§7 Phase 8) has much shorter retention than Azure Monitor, weakening idle-server confidence | Certain, once that check ships | Shorter lookback window than Azure's `idle` command; label the finding's description as lower-confidence explicitly |
| `subscriptions` table's Azure-AD shape continues to not fit Hetzner's single-token model if Phase 7 is skipped or delayed indefinitely | Certain (already true today) | The env-var workaround (§7 Phase 7's "before" state) is functional but requires at least one Azure subscription row to exist even for a Hetzner-only user — treat Phase 7 as a real backlog item, not a "nice to have," once more than one Hetzner project needs to be scanned |
| Dual-language command-list drift (§2.1) recurs even after Phase 1, because Phase 1 only fixes the Go side — `web/lib/btg-commands.ts` remains a second hand-maintained source of truth | Medium | Not solved by any single phase above; worth a follow-up decision (out of scope for this plan) on whether the Go binary should expose its registered command list at runtime (e.g. a `btg-devops list-commands --output json` command) for the web layer to consume instead of hand-maintaining a parallel TS list |
| Phase 8's "SSH key not attached" check gets rebuilt anyway despite §6 flagging it as not cleanly expressible, because the original (now-superseded) proposal is still referenced elsewhere | Low–Medium | This document supersedes that specific claim; treat §6's verdict as current |

---

## Verdict

Nothing here requires a rewrite. `provider.Analyzer` and the registry (§4) are already the right
abstraction and are done; the remaining work is finishing what they were supposed to obsolete —
`analyze_all.go`'s pre-registry design (§4, §7 Phase 1) — and closing five smaller, independently
shippable duplication gaps (§2, §7 Phases 3–5) that exist because Hetzner was built by copying
Power Platform's patterns under time pressure rather than generalizing them up front, which was
the correct trade-off for a first working slice and is now cheap to fix in isolation. The two
structurally deeper items — no `provider` column (§5, low risk, additive) and a 3-level rather
than 4-level severity scale (§5, §7 Phase 6, high risk, deliberately sequenced last and isolated
to one existing seam) — remain, as before, addressable as isolated phases rather than blockers.
