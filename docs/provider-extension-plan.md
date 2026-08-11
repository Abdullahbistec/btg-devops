# Provider Extension Plan: Azure → Power Platform → Hetzner

**Status:** Read-only analysis. No source files were modified to produce this document.
**Scope:** `cmd/` (Go CLI) and `web/` (Next.js dashboard) as they exist on branch `abd-production`.

## 0. Framing

This document evaluates whether the existing Azure analyzer codebase (currently
attributed in this task as the colleague's reference implementation, 14
analyzers as of this branch — the original 13 plus `idle`, added and reviewed
earlier on this same branch) can be **extended in place** into a
multi-provider platform — Azure → Power Platform → Hetzner — without rewriting
or modifying Azure detection logic.

One important correction to the premise: **Power Platform is not a separate
codebase to "port in."** It already lives in this exact repository, in the
same `cmd/` package, following the same conventions, registered the same way.
5 PP analyzers exist today: `powerplatform`, `pp-environments`, `pp-apps`,
`pp-flows`, `pp-powerbi`. The real generalization work is: (a) formalize the
shared interface both Azure and PP already implicitly follow, and (b) extend
that same interface to a genuinely new, third-party provider — Hetzner —
which has no code here yet at all.

---

## 1. Current Shape

### 1.1 Package layout

Everything lives in one flat Go package, `cmd/` (module
`github.com/chanbistec/btg-devops`, `go.mod:1`). There is no `internal/`,
no `pkg/`, no per-provider subpackage. 34 non-test `.go` files sit directly in
`cmd/`.

Top-level command tree (`cmd/root.go:10-15`, `cmd/analyze.go:7-14`):

```
btg-devops (root, cmd/root.go)
└── analyze (cmd/analyze.go)
    ├── 13 Azure security/config commands + idle
    ├── 5 Power Platform commands
    └── all (cmd/analyze_all.go — fans out across a fixed Azure+PP list)
└── mcp (cmd/mcp.go — exposes analyzers as MCP tools)
```

Every leaf command lives in its own file, named after the command
(`cmd/storage.go`, `cmd/nsg.go`, `cmd/idle.go`, `cmd/pp_environments.go`, …).

### 1.2 The pattern every analyzer follows (verified across all 14 Azure files)

Grepped every Azure command file for its struct/registration/entry-point
lines. All 14 are structurally identical:

| File | Finding struct | Cobra var | `RunE` | `init()` |
|---|---|---|---|---|
| `cmd/acr.go` | `ACRFinding` (18) | `acrCmd` (40) | `runACR` (44) | `init()` (47) |
| `cmd/appservice_traffic.go` | `AppTrafficReport` (22) | `appserviceTrafficCmd` (39) | `runAppServiceTraffic` (43) | `init()` (46) |
| `cmd/appserviceplan.go` | `ASPFinding` (20) | `appServicePlanCmd` (46) | `runAppServicePlan` (50) | `init()` (53) |
| `cmd/cognitiveservices.go` | `CognitiveServicesFinding` (18) | `cognitiveservicesCmd` (41) | `runCognitiveServices` (45) | `init()` (48) |
| `cmd/cosmosdb.go` | `CosmosDBFinding` (19) | `cosmosdbCmd` (41) | `runCosmosDB` (45) | `init()` (48) |
| `cmd/functions.go` | `FunctionsFinding` (18) | `functionsCmd` (54) | `runFunctions` (58) | `init()` (61) |
| `cmd/iam.go` | `Finding` (26, bare name — this file also owns the shared `Severity` type) | `iamCmd` (73) | `runIAM` (77) | `init()` (80) |
| `cmd/idle.go` | `IdleFinding` (24) | `idleCmd` (69) | `runIdle` (73) | `init()` (76) |
| `cmd/keyvault.go` | `KeyVaultFinding` (19) | `keyvaultCmd` (41) | `runKeyVault` (45) | `init()` (48) |
| `cmd/nsg.go` | `NSGFinding` (18) | `nsgCmd` (42) | `runNSG` (46) | `init()` (49) |
| `cmd/publicip.go` | `PublicIPFinding` (18) | `publicIPCmd` (45) | `runPublicIP` (49) | `init()` (52) |
| `cmd/resourcegroup.go` | `RGFinding` (21) | `resourceGroupCmd` (46) | `runResourceGroup` (50) | `init()` (53) |
| `cmd/sp_expiry.go` | `SPExpiryFinding` (18) | `spExpiryCmd` (74) | `runSPExpiry` (86) | `init()` (89) |
| `cmd/storage.go` | `StorageFinding` (18) | `storageCmd` (41) | `runStorage` (45) | `init()` (48) |

Every `init()` does exactly two things: `analyzeCmd.AddCommand(xCmd)` and
register that command's flags. There is no variation in this shape across 14
files.

### 1.3 The `Finding` shape

No two Finding structs are identical (each has domain-specific fields:
`StorageFinding.StorageAccount`, `NSGFinding` presumably has an NSG name
field, etc.) but every one shares this spine:

```
Severity       Severity `json:"severity"`
Category       string   `json:"category"`
<domain field> string   `json:"<domain>_name"`   // e.g. storage_account, resource_name
Description    string   `json:"description"`
Recommendation string   `json:"recommendation"`
```

`Severity` is a named string type with exactly three constants, defined once
in `cmd/iam.go:17-23`:

```
type Severity string
const (
    Critical Severity = "Critical"
    Warning  Severity = "Warning"
    Info     Severity = "Info"
)
```

Every other file imports nothing to use this — it's the same package, so
`Severity`/`Critical`/`Warning`/`Info` are just in scope everywhere.

### 1.4 Shared helpers and config convention

Defined once, reused everywhere (no interfaces, just plain package-level
functions/vars):

- `getSubscriptionID()` — `cmd/appservice_traffic.go:53-58` — flag override,
  falls back to `AZURE_SUBSCRIPTION_ID` env var.
- `getTenantID()` — `cmd/powerplatform.go:150` — same pattern for tenant.
- `deref()` — `cmd/iam.go:482` — nil-safe `*string` dereference (Azure SDK
  returns pointers everywhere).
- `extractResourceGroup()` — `cmd/appservice_traffic.go:238` — parses a
  resource group name out of an ARM resource ID string.
- Shared flag vars, declared once in a `var (...)` block —
  `cmd/appservice_traffic.go:17-21`: `flagSubscriptionID`, `flagResourceGroup`,
  `flagOutput`. `flagTenantID` similarly in `cmd/powerplatform.go:135`.

Credentials are **always** environment variables, read directly with
`os.Getenv`, never a config file or shared struct. Power Platform has its own
override set (`BTG_PP_TENANT_ID`/`BTG_PP_CLIENT_ID`/`BTG_PP_CLIENT_SECRET`,
resolved in `web/lib/btg-runner.ts:30-37`, `getPPCredentials()`) so a
different service principal can be used for PP without touching the Azure
vars. Documented in `web/.env.local.example:7-25`.

### 1.5 Error handling

Uniform across every `runXxx` (sampled `cmd/keyvault.go:55-70`,
matches every other file): validate required input and return a plain
`fmt.Errorf` with an actionable message (state exactly which flag or env var
to set), wrap every SDK error with `fmt.Errorf("...: %w", err)`, write
human progress lines to `os.Stderr` (never stdout — stdout is reserved for
the final table/JSON so it stays parseable), page through Azure SDK list
results with the SDK's own `NewListPager`/`NewListBySubscriptionPager`.

### 1.6 Output

Every `runXxx` ends with `switch flagOutput { case "json": ...; default:
printXxxTable(...) }`. JSON is `json.NewEncoder(os.Stdout)` with 2-space
indent, wrapping a `<Name>Report{ Summary, Findings }` struct. This is a
convention, not an interface — nothing enforces the `{summary, findings}`
shape; it's just what every file happens to do.

### 1.7 Test style

`cmd/pp_test.go`, `cmd/usage_test.go`, `cmd/idle_test.go` — the only test
files in the package. All three share one style: pure-logic unit tests, no
live API calls, no mocking framework, table-driven where a function has
multiple branches (e.g. `TestCalcWasteScore_PercentBased_High`,
`TestIdleCategory_PublicIPIdle`). Nothing tests HTTP/SDK interaction directly.

### 1.8 Storage layer

`web/lib/db.ts`, Node's built-in `node:sqlite`, WAL mode
(`web/lib/db.ts:9-16`). Five tables: `subscriptions`, `audits`, `findings`,
`schedules`, `users`. Schema is created inline via `CREATE TABLE IF NOT
EXISTS` plus a handful of `ALTER TABLE ... ADD COLUMN` migrations wrapped in
`try/catch` (`web/lib/db.ts:96-101`) — there is no migrations directory or
version table.

`findings` (`web/lib/db.ts:49-61`): `id, audit_id, service, resource,
environment, severity, category, description, recommendation, created_at`,
plus two later-migrated columns `remediation_status`, `owner`. **No
`provider` column exists.** The only thing distinguishing an Azure finding
from a PP finding is the free-text `service` value (`"Storage"` vs.
`"PP Environments"`, etc.) — see 2.4.

`subscriptions` (`web/lib/db.ts:20-30`): `id, name, subscription_id,
tenant_id, client_id, client_secret, is_active, created_at, last_audit_at`.
This is an **Azure ARM credential shape** (subscription/tenant/client),
seeded straight from `AZURE_*` env vars (`web/lib/db.ts:103-117`).

### 1.9 How the dashboard invokes the CLI

`web/lib/btg-runner.ts` never calls Go code in-process. It shells out per
command (`execFile`, `web/lib/btg-runner.ts:112-136`,
`runCommand()`), once per analyzer, with `analyze <command> --output json`.
`runAllCommands()` (`btg-runner.ts:202-233`) loops a caller-supplied command
list sequentially, branching credentials only on a binary
`isPP()` check (`btg-runner.ts:214-215`) — Azure creds or PP creds, nothing
else.

Two parallel, independent heuristics turn each analyzer's raw JSON into a
common shape — they do **not** share code:

- Go side: `cmd/analyze_all.go`'s `extractFindings()` +
  `resourceFields` list — used only by `analyze all`, which the dashboard
  doesn't call.
- TS side: `web/lib/btg-runner.ts`'s `extractResource()` (102-110) — a
  separate field-guessing list, used by the dashboard's actual audit path.

(This exact duplication and one resulting bug — `pp-environments`'s
`Resource` field coming back empty in `analyze all` JSON — is documented in
full in `docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md`,
written and approved earlier this session, not yet implemented. See §3.)

### 1.10 How the dashboard reads results

`web/app/api/findings/route.ts` and `web/app/api/dashboard/route.ts` both
scope by provider the same hardcoded way: a `PP_LIST` set built from
`PP_SERVICE_LABELS` (`web/lib/btg-commands.ts:34-40`), then
`service IN (...)` / `service NOT IN (...)` (`findings/route.ts:40-41`).
This is a **binary** split — Azure or PP — baked into a SQL string, not an
N-way provider filter.

---

## 2. Generalization Verdict

**There is no provider abstraction anywhere in this codebase today.** Azure
is not "mostly generalized with a few rough edges" — it is the only provider
concept that exists, and Power Platform is bolted on next to it via
duplicated two-way branches, not a third case in an N-way structure. Every
place listed below currently hardcodes exactly two providers (Azure, PP) and
would need to become N-way for Hetzner to join as a peer, not a special case:

| # | Location | What's hardcoded |
|---|---|---|
| 1 | `cmd/analyze_all.go` — `allAzureCmds` (13-entry slice), `allPPCmds` (5-entry slice), `allServiceLabels` (map) | Two fixed command lists, no registry |
| 2 | `cmd/analyze_all.go`'s `--scope` flag handling | `switch flagAllScope { case "azure": ...; case "pp": ...; default: both }` — a Hetzner case does not exist and the pattern only accommodates 2 |
| 3 | `web/lib/btg-commands.ts` — `AZURE_COMMANDS`, `PP_COMMANDS`, `ALL_COMMANDS` | Same duplication, TypeScript side |
| 4 | `web/lib/btg-runner.ts:214-215` — `isPP()` | Binary credential routing; a 3rd provider needs a 3rd credential set with no branch to hold it |
| 5 | `web/lib/btg-runner.ts:17-22` — `Credentials` type (`tenantId, clientId, clientSecret, subscriptionId`) | Shape is Azure AD service-principal-specific; Hetzner auth is a single API token, doesn't fit this shape at all |
| 6 | `web/lib/db.ts:20-30` — `subscriptions` table | Same Azure-AD-shaped columns, persisted; not just an in-memory type |
| 7 | `web/app/api/findings/route.ts:6,40-41` and `api/dashboard/route.ts` (same pattern) | `PP_LIST`-based `IN`/`NOT IN` binary scope filter |
| 8 | `web/app/audits/page.tsx` — `AUDIT_STEPS` | Hardcoded per-command progress-bar entries (already needed a fix once this session when `idle` was added and initially missed here — see git history) |
| 9 | `web/app/reports/page.tsx` — `CMD_COLORS` | Same pattern, chart colors per command |
| 10 | `web/app/dashboard/page.tsx` — `isPP` boolean, `PP_CHART_ENTRIES` | Dashboard's whole rendering branches on one boolean, not a scope enum |
| 11 | `web/app/cost/page.tsx` — `COST_CATEGORIES` set | Category vocabulary assumes Azure/PP waste categories (`Zero Usage`, `Unused IP`, `Stale Flow`); Hetzner will need its own categories added here |
| 12 | `web/lib/db.ts` `findings` table | No `provider` column at all — see §5 |
| 13 | `cmd/iam.go:17-23` — `Severity` | 3-level, not the 4-level canonical scale requested |

Thirteen distinct places. None of them are deep — each is a short,
well-isolated list or branch — but there are a lot of them, and #5/#6/#12/#13
are structural (schema/type shape), not just list membership.

---

## 3. Target Interface

**Good news: this exact problem was already scoped and designed once this
session**, before Hetzner was on the table —
`docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md`.
It proposes precisely the missing piece: a real `Analyzer` interface (in a
new `cmd/analyzer.go`) that all 18 existing commands (13 Azure + 5 PP)
implement via a thin adapter, verified against the actual pattern in §1.2
above and confirmed **not to require touching any analyzer's detection
logic** — only adding one small adapter type and one line inside each
file's existing `init()`.

That design's interface shape (`Name() string`, `Run(ctx) ([]UnifiedFinding,
error)`) is 90% of what's needed here. Two changes make it a genuine
multi-provider interface rather than an Azure/PP one:

- Add a `Provider() string` method (or fold it into registration — see §4)
  so the registry, not the interface itself, knows what provider an
  analyzer belongs to.
- `UnifiedFinding.Severity` needs to carry the 4-level canonical scale
  instead of the current 3-level `Severity` type — see §5 for why this is
  its own, higher-risk piece of work.

**Can the 14 Azure analyzers satisfy this unmodified?** Yes — confirmed
directly against the interface shape in §1.2/§1.3: every `runXxx` already
separates cleanly into "build auth → fetch → analyze → produce a Finding
slice" followed by "print." The existing spec's adapter pattern (wrap the
first half, leave the second half as `runXxx` already is) requires zero
changes to the fetch/analyze logic itself. The same is true for the 5 PP
analyzers — they follow the identical shape.

**Would Hetzner need an adapter, or does it get the interface for free?**
Any new provider written from scratch should implement `Analyzer` directly —
there's no legacy code to adapt around. The "thinnest possible adapter"
question only applies to Azure/PP, and the answer there is: the adapter is
already fully specified in the existing design doc.

---

## 4. Provider Registry Design

The existing spec's registration split (`registerAzureAnalyzer` /
`registerPPAnalyzer`, two package-level slices — see spec §1) is itself
still a 2-way, not N-way, structure. Generalizing it:

- One registry: a `map[string][]Analyzer` keyed by provider name
  (`"azure"`, `"powerplatform"`, `"hetzner"`), instead of two named slices.
- One registration function: `registerAnalyzer(provider string, a
  Analyzer)`, called once per command's `init()` — same call site the
  existing spec already proposes, just parameterized.
- `btg-devops analyze <command>` is unaffected — leaf commands don't change
  names or move.
- `btg-devops analyze all --scope <provider>` (today: `azure`/`pp`/`all`)
  extends to any registered provider key, including `hetzner`, once at
  least one Hetzner analyzer registers itself — no code change needed in
  `analyze_all.go` beyond reading from the map instead of the switch
  statement in §2, item 2.
- New Hetzner leaf commands follow the existing `pp-*` naming precedent
  (`cmd/pp_environments.go` etc.) with an equivalent prefix, e.g.
  `analyze hetzner-volumes`, `analyze hetzner-servers` — keeping the flat
  command namespace intact rather than introducing Cobra subcommand nesting
  (`hetzner volumes`), which nothing else in this CLI does.

---

## 5. Shared Findings Schema

### 5.1 Adding `provider`

`findings` needs one additive column, following the exact migration pattern
already used three times in this file (`web/lib/db.ts:96-101`,
`ALTER TABLE ... ADD COLUMN` wrapped in `try/catch`):

```
ALTER TABLE findings ADD COLUMN provider TEXT DEFAULT ''
```

Existing rows get backfilled once from `service` (Azure service labels →
`'azure'`, PP service labels → `'powerplatform'`) using the same
`PP_SERVICE_LABELS` set that already exists for this exact classification
(`web/lib/btg-commands.ts`). This is additive and reversible — nothing reads
`provider` until the code that populates and filters on it exists, so this
column can land as its own PR with no behavior change.

### 5.2 Severity: 3 levels → 4 levels

This is the highest-blast-radius single item in this whole plan. The literal
strings `"Critical"`, `"Warning"`, `"Info"` are not confined to `cmd/iam.go`
— they're compared and rendered as exact string literals throughout the TS
dashboard (severity filter buttons, `SEV_COLOR` maps, `printAllTable`'s
Critical/Warning-only display logic in `cmd/analyze_all.go:283-297`, the
`findings_by_severity` tallying in every single `IdleSummary`-style struct).
A mapping (proposed, not yet a recommendation to execute as part of Hetzner
work — see §7):

| Current (`Severity`) | Canonical | Rationale |
|---|---|---|
| `Critical` | `critical` | Direct |
| `Warning` | `high` | Preserves "this needs attention soon" meaning |
| *(unused today)* | `medium` | Reserved — no existing Azure/PP check currently needs a level between `Warning` and `Info`; new providers (Hetzner) can use it for checks that genuinely sit in that gap |
| `Info` | `low` | Direct |

This mapping is a judgment call, not a derived fact — flagging it explicitly
as something to confirm with whoever owns the dashboard's severity UX before
committing to it, since it changes what every existing Critical/Warning/Info
finding displays as.

### 5.3 What does *not* need to change

The rest of the `findings` row shape (`service, resource, environment,
category, description, recommendation, owner`) is already provider-neutral
— it's plain strings, nothing Azure-specific. Hetzner findings fit this
shape as-is; only `provider` and (eventually) `severity`'s value space
change.

---

## 6. Hetzner Analyzer Proposal

Mapping the existing Azure analyzers onto the four pillars the task
describes (cost waste / security gaps / stale resources / best-practice
violations), to ground the Hetzner proposal in real precedent rather than
inventing a new taxonomy:

| Pillar | Azure precedent | Hetzner Cloud equivalent |
|---|---|---|
| Cost waste | `idle` (zero-usage/over-provisioned resources), `appservice-traffic` (idle App Services) | Unattached Volumes (billed, unmounted), unassigned Floating IPs (billed, unattached), stopped Servers still billed, low-CPU-utilization Servers over a lookback window, orphaned Snapshots never used to create a Server |
| Security gaps | `nsg` (network rules), `iam` (role assignments), `keyvault` (access policies), `storage` (public access), `acr` (admin user/public access) | Servers with no Firewall attached at all, Firewall rules allowing `0.0.0.0/0` on sensitive ports, Servers still booted from a deprecated Image |
| Stale resources | `resourcegroup` (empty groups), `sp_expiry` (expired credentials) | Volumes detached for N+ days, SSH Keys not attached to any Server, old unused Snapshots |
| Best-practice violations | `storage` (TLS version, lifecycle policy), `keyvault` (soft-delete/RBAC), `cosmosdb` | Servers without the backup window enabled, Load Balancers with no health check configured, Certificates nearing expiration (direct parallel to `sp_expiry`) |

### 6.2 Hetzner Cloud API coverage

Hetzner Cloud's API (`api.hetzner.cloud/v1`) is a plain REST/JSON API. What
each proposed check needs:

- `GET /servers` — status, server_type, datacenter, public_net, private_net,
  backup_window, image. Covers most checks above directly.
- `GET /volumes` — size, `server` (null when unattached).
- `GET /floating_ips` — `server` (null when unassigned).
- `GET /firewalls` — rules + `applied_to`, cross-referenced against `/servers`.
- `GET /ssh_keys`, `GET /images` (type=snapshot), `GET /certificates`,
  `GET /load_balancers` — one call each, all list endpoints.
- `GET /servers/{id}/metrics?type=cpu,disk,network` — basic time-series
  metrics, needed for idle-server detection.

### 6.3 What's *not* expressible

- **No cost-management API.** Unlike `armcostmanagement` (used by the
  already-shipped `idle` command's cost-trend logic, `cmd/usage.go:16` per
  the idle/waste-detection design spec), Hetzner has no per-resource
  historical billing query API — only a static `GET /pricing` list-price
  endpoint. Waste findings can report *"N unattached volumes, 500 GB total,
  ~€X/month at list price"* but not an actual historical spend trend the way
  `idle`'s `queryCostTrend()` does for Azure.
- **Thin metrics compared to Azure Monitor.** The metrics endpoint exists
  but has materially shorter retention and fewer metric types than Azure
  Monitor — idle-server detection will need a shorter lookback window and
  should be documented as lower-confidence than the Azure `idle` command's
  equivalent classification.
- **No IAM/RBAC equivalent.** Hetzner Cloud API tokens are project-scoped
  with a single read/write permission bit — there is no per-resource role
  assignment model to audit. An `iam`-equivalent Hetzner analyzer does not
  have a real target; this pillar has no direct Hetzner counterpart and
  should be dropped rather than forced.

### 6.4 New dependency question

Per the "no new dependencies unless unavoidable" constraint: **a new
dependency is avoidable here.** Hetzner's API is plain REST/JSON with token
auth in a header — the existing codebase's own HTTP-calling convention
(`cmd/pp_helpers.go`'s `ppFetch()`, a ~25-line `net/http` wrapper used by
every Power Platform analyzer) is directly reusable as a template for an
equivalent Hetzner fetch helper, needing only the stdlib. The official
`hetznercloud/hcloud-go` SDK is an option but not required; recommending the
stdlib-only path to match the PP analyzers' own precedent and avoid the new
dependency entirely. **Flagging this as a decision point, not a settled
recommendation** — the SDK does provide built-in pagination/retry handling
the hand-rolled version would need to replicate.

---

## 7. Migration Sequence

Each phase is independently shippable and revertable (a `git revert` of any
single phase does not require reverting any other phase):

| Phase | Work | Blast radius |
|---|---|---|
| **0** | Implement the already-approved Analyzer interface design (13 Azure + 5 PP adapters, `cmd/analyzer.go`, `analyze_all.go` rewiring) — zero new capability, pure groundwork | Touches all 18 analyzer files' `init()` (one line each) + `analyze_all.go`. No behavior change; existing tests + a byte-for-byte `analyze all --output json` diff (before/after) are the acceptance check. |
| **1** | Add `provider` column to `findings` + backfill from `service` | One `ALTER TABLE`, one backfill script. Nothing reads the column yet — no behavior change. |
| **2** | Generalize the registry (§4): 2 fixed slices → `map[string][]Analyzer`; `--scope` flag reads the map's keys instead of a switch statement; `btg-commands.ts` restructured the same way | Moderate — touches `analyze_all.go`, `btg-commands.ts`, `findings/route.ts`, `dashboard/route.ts` scope filters. Fully backward-compatible if Azure/PP output is unchanged (same acceptance check as Phase 0). |
| **3** | Sever the `subscriptions` table's Azure-only shape — add a parallel `hetzner_projects`-style table (or a provider-agnostic `credential_sets` table) rather than reshaping `subscriptions` in place | Additive if a parallel table; breaking if `subscriptions` itself is reshaped. **Recommend the additive path** to keep this phase low-risk. |
| **4** | Build the first Hetzner analyzer end-to-end (recommend: unattached Volumes — simplest, no metrics dependency, clearest cost-waste story) as `cmd/hetzner_volumes.go`, following §1's conventions exactly | New file, new command, new registry entry. Zero risk to existing providers. |
| **5** | Wire Hetzner into the dashboard: `web/lib/btg-commands.ts` gets a `HETZNER_COMMANDS` list, `AUDIT_STEPS`/`CMD_COLORS`/`COST_CATEGORIES` get Hetzner entries, `dashboard/page.tsx`'s `isPP` boolean becomes a 3-way scope | Same pattern as the fix already made this session when `idle` was wired in (`web/app/audits/page.tsx`, `reports/page.tsx`) — known, bounded work. |
| **6** | Remaining Hetzner analyzers (Firewalls, idle Servers, stale SSH Keys, Certificate expiry, …), one command per PR, same as the idle-detection port's own precedent | Each is additive and independent. |
| **7 (separate track, not a prerequisite for Hetzner)** | Severity scale migration, §5.2 | Highest blast radius in this entire plan — isolate it from all Hetzner work so a problem here never blocks or gets tangled with provider work. |

Note: Phase 7 is deliberately **not** a prerequisite for Phases 4-6. Hetzner
analyzers can ship using the existing 3-level `Severity` (matching Azure/PP
exactly) and migrate to the 4-level scale later, in one dedicated pass across
all three providers at once — this avoids having Hetzner findings look
different from Azure/PP findings for however long the severity migration
takes.

---

## 8. Risk Table

| Risk | Likelihood | Mitigation |
|---|---|---|
| Severity scale migration (§5.2) breaks a hardcoded `'Critical'`/`'Warning'`/`'Info'` comparison somewhere in the TS dashboard | High, if attempted | Isolate as Phase 7, its own PR, with an exhaustive grep-for-literal-strings pass before and after; do not bundle with any Hetzner work |
| Hetzner's lack of a cost-history API produces misleadingly precise-looking waste $ figures | Certain unless addressed | Report waste in resource-count/GB terms + static list price, not a trend; say so explicitly in each finding's description |
| Hetzner's metrics API has much shorter retention than Azure Monitor, weakening idle-server confidence | Certain | Shorter lookback window than Azure's `idle`; label Hetzner idle findings as lower-confidence in their description text |
| `subscriptions` table's Azure-AD shape doesn't fit Hetzner's single-token auth model | Certain (schema mismatch) | Additive parallel table (Phase 3), not a reshape of `subscriptions` |
| Registry generalization (Phase 2) subtly changes Azure/PP's existing `analyze all` output (ordering, an omitted command) | Medium | Byte-for-byte JSON diff of `analyze all --output json` before/after, for both `--scope azure` and `--scope pp` |
| New Hetzner Go SDK dependency (if chosen over stdlib) drifts in API/version over time | Low-Medium | Prefer the stdlib `net/http` approach (§6.4), matching the existing PP analyzers' own precedent, which has zero such dependency today |
| Hetzner code doesn't actually match Azure's conventions closely enough for "a reviewer can't tell who wrote which provider" | Medium | Use this document's §1 table as a literal checklist during Hetzner PR review — same struct spine, same error-message phrasing style, same `os.Stderr`-for-progress/`os.Stdout`-for-output split |
| This work lands while the `idle`/waste-detection PR (this branch's most recent work) is still under review, causing merge conflicts or review confusion | Medium | Sequence Phase 0 onward to start only after that PR merges, as separate PRs against the resulting base, not stacked on top of an unmerged branch |

---

## Verdict

**Extend-in-place feasible: yes** — because all 14 existing Azure analyzers
already follow one uniform, mechanically-verified convention (§1.2) that a
previously-approved, unimplemented design (§3) already shows how to
formalize into a real interface without touching any analyzer's detection
logic; the dashboard's provider-scoping, while hardcoded in thirteen places
(§2), is hardcoded as short, well-isolated lists rather than deep
entanglement; and Hetzner's own object model maps cleanly onto the same
four-pillar shape Azure already uses (§6). The two genuinely structural gaps
— no `provider` column (§5.1, low risk, additive) and a 3-level rather than
4-level severity scale (§5.2, high risk, deliberately sequenced last and
independently of all Hetzner work in §7) — are both addressable as isolated,
revertible phases rather than blockers to starting.
