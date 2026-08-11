# Deep Research Playbook — instructions for the scheduled Claude Code agent

> Read first: `spec/handoff/08-mcp-claude-orchestrator.md` (the MCP server + scheduled agent
> architecture this runs inside) and `spec/handoff/10-deep-research-analysis.md` (the strategy this
> file implements — task 5.1 in that spec's component list).
>
> This file is what EVERY `analysis_request` points the scheduled Claude Code agent at — a single
> resource type, "cost", "usage:<type>", or "all" (spec 10 §4, updated: deep research is no longer
> a separate opt-in scope; every Analyze request always follows this 5-stage process, no exceptions
> — see `getScopedAuditData` in `claude.ts`, which appends `DEEP_RESEARCH_DIRECTIVE` to every
> scope's instruction). There is no one-shot/fast mode left to fall back to.
>
> **`scope === "all"` is a special case (spec 13/spec 15 §B2, split finalized §B9):** everything
> below this note (Preconditions through Stage 5) is what you follow directly for a single resource
> type, `"cost"`, or `"usage:<type>"` request — proceed as normal, nothing changes for those. For an
> `"all"` request specifically, do NOT run the 5 stages yourself in one pass. Instead:
> 1. Call `list_changed_scopes(auditId)` to see which resource-type scopes actually changed since
>    the last analyzed audit.
> 2. For each unchanged scope, call `get_cached_scope_analysis(auditId, scope)` — no agent needed for
>    these; if it returns null, treat that scope as changed instead (fall back to step 3 for it).
> 3. For each changed scope, spawn one per-type agent following
>    `spec/agent/parallel-per-type-agent-prompt.md` (fill in `{SCOPE}`/`{RELATED_SCOPES}` per the
>    related-types map in `spec/handoff/13-parallel-resource-agents.md`), all in parallel.
> 4. Once every per-type agent (step 3) has returned, run ONE synthesis pass following
>    `spec/agent/parallel-synthesis-agent-prompt.md`, giving it both the fresh per-type results and
>    the cached ones from step 2 (mark the cached ones `carried_forward: true`).
> 5. Only the synthesis pass calls `save_analysis` — for an `"all"` request, you (the top-level
>    agent) never call `save_analysis` yourself; the synthesis step's call is the one that resolves
>    the pending request.
>
> This is the only difference `"all"` requests have from every other scope — the underlying stages
> (build the map, correlate, chain, judge in context, verify) are unchanged; they just run split
> across dedicated per-type agents plus a synthesis pass instead of in one sequential context.

## Preconditions

- You have MCP tools: `list_pending_requests`, `get_audit_data(auditId, scope)`,
  `get_audit_history(auditId, scope?, limit?)`, `save_analysis`.
- `list_pending_requests` will not always show every scope a fresh audit collected data for. Before
  returning its list, the server silently resolves any scope whose config is unchanged since the
  last audit it actually analyzed — it copies that prior analysis's findings forward itself (spec
  14 — per-scope analysis cache) and never surfaces that scope to you at all. This is expected and
  not a gap: a subscription with few changes day-to-day will show fewer pending requests than its
  resource-type count, and that's the cache working as intended, not missing data. Only reason
  about scopes `list_pending_requests` actually gives you — do not try to infer or re-derive
  findings for a scope you were never asked about.
- Whatever scope this request names (a resource type, "cost", "usage:<type>", or "all"), do not
  limit yourself to the data `get_audit_data` returned for that scope alone — call `get_audit_data`
  again with a DIFFERENT scope as needed to build the context Stage 1 requires (other resource
  types, cost, usage, or "all" for the complete picture). You are not limited to one fetch. Hold
  everything in context across calls before writing any conclusion.
- Every severity you assign must follow the rubric returned in each `get_audit_data` call's
  `instruction` field (Critical = exploitable/exposed/bleeding money now; Warning = real risk
  needing another factor; Info = best-practice deviation with no current impact; tie-break low).
  `issue` is the plain-English problem statement for a non-technical reader — it must NOT contain
  raw field names/values. `evidence` is a separate, required field on every finding that must cite
  the specific field/value that proves the issue (e.g. `publicNetworkAccess = "Enabled", ipRules =
  [] (empty)`) — the UI renders `issue` and `evidence` as two distinct sections ("the problem" vs.
  "why this is flagged"), so do not fold one into the other. These rules are not relaxed for deep
  research — if anything, hold them stricter, since deep findings carry more weight with the
  reader.

## Stage 1 — Build the map

Before looking for a single problem, fetch every resource type plus `cost` and each `usage:<type>`
available for this audit, and build an internal picture:

- **Environments**: infer prod / dev / QA / UAT / sandbox from resource names, resource group
  names, and any tags present in the data. Write this mapping down for yourself — you will need it
  in Stage 4.
- **Regions**: which regions are actually in use, and which resource groups/apps live in which.
- **Application groupings**: which resources plausibly form one application together (e.g. an App
  Service + the Cosmos DB account + the Storage account it references) — infer from naming
  conventions, shared resource groups, or explicit connection references in the data.
- **Spend shape**: from the cost data, what are the top line items? Where does the money actually
  go?

Do not report any finding yet. This stage only builds context used by every later stage.

## Stage 2 — Correlate datasets

For every resource that is significant by cost or by role in an application grouping (from Stage
1), join configuration, cost, and usage together for that SAME resource — this is the join no
single-scope analysis performs:

- Provisioned capacity (RU/s, SKU/tier, instance count) vs. actual utilization from the usage
  data. A large gap is a concrete, quantifiable finding (e.g. "provisioned at X, 30-day peak is Y,
  ~$Z/month of that capacity is unused").
- Cost with no corresponding usage signal at all → likely orphaned/abandoned resource.
- A premium/production-grade tier sitting under a resource whose naming/resource-group says
  dev/test/sandbox.

Every finding produced in this stage should have a `cost_impact_usd` figure derived from the
correlation, not a guess — show your arithmetic in the `evidence` field (keep `issue` as the plain-
English waste statement, e.g. "This Cosmos DB account is provisioned far above what it uses").

## Stage 3 — Chain issues into attack paths

A single fact ("NSG rule open to 0.0.0.0/0", "managed identity has Key Vault access") is common and
low-value on its own. The valuable finding is the CHAIN — multiple individually low/medium-severity
facts that, connected, describe a real path from an entry point (usually a public IP or open NSG
rule) to something valuable (production data, secrets, an admin identity).

To build a chain:
1. Start from every public-facing entry point in the data: a Public IP resource, an NSG rule open
   to the internet, or an App Service/Function App with public network access and no auth
   configured.
2. Follow what identity that entry point holds — App Services, Function Apps, Cosmos DB accounts,
   Storage accounts, ACR, and Cognitive Services can all carry a managed identity
   (`identity.principalId` in their own data) or explicit role assignments (the `iam` data).
3. Follow that identity's access forward — check Key Vault `accessPolicies`/RBAC role assignments
   for that same `principalId`, and check what storage/Cosmos DB connection strings or secrets that
   Key Vault holds — until you reach something with real value (production credentials, production
   data, an ability to escalate further).
4. If the chain reaches something valuable, that is a headline finding — severity almost always
   Critical (it satisfies "actively exploitable now" even if every individual link looked like a
   Warning or Info in isolation), and it must be reported as ONE finding describing the full path,
   not as several disconnected findings.

Note: this subscription has no Virtual Machines (confirmed via `az vm list` — empty), so chains
never involve a VM as a hop. Every chain here runs through PaaS resources (App Service, Functions,
Cosmos DB, Storage, Key Vault) and their managed identities/role assignments instead. Example:
"App Service `app-x` has public network access with no auth configured (`publicNetworkAccess:
Enabled`, no `authsettingsV2` configured) → its system-assigned identity (`identity.principalId:
Y`) holds an access policy on Key Vault `kv-prod` granting `get`/`list` on secrets → `kv-prod`
contains the connection string for production Cosmos DB account `Z`." If a future audit of a
different subscription does have VMs and this gap becomes real, see spec 10 §5.5/§6 for the
decision on adding a VM/NIC extractor before applying this chain logic to VM-based paths.

Represent a chain finding in `save_analysis` using these fields:
- `finding_type`: `"chain"` — this is what makes it render as a distinct headline card at the top
  of the analysis page instead of blending into the regular findings list. Every ordinary finding
  should omit this field (or set `"standard"`).
- `resource_name` / `resource_type`: the chain's starting point (the internet-facing resource).
- `affected_resources`: every resource name in the chain, in order.
- `issue`: the full narrative in plain English, written as the chain itself, hop by hop (see the
  App Service → Key Vault → Cosmos DB example above) — no raw field names/values here.
- `evidence`: the actual field/value backing each hop in the same order (e.g.
  `publicNetworkAccess: Enabled, authsettingsV2: absent → identity.principalId: Y → Key Vault
  access policy grants get/list → connection string for Cosmos DB Z`).
- `cost_impact_note`: `"security risk"` (chains found this way are virtually never cost findings).
- `fix_effort`: still set normally (quick/moderate/complex) — a chain finding's severity and its
  fix cost are independent, same as any other finding.

## Stage 4 — Judge in context

Before finalizing severity on ANY candidate finding (from Stage 2, Stage 3, or an ordinary
checklist-style finding), weigh it against the Stage 1 map and against history:

- The same misconfiguration is Critical in a production-tagged resource group and Info in a
  sandbox one. Never assign severity from the issue type alone — always cross-check which
  environment it's actually in.
- "No secondary region / no failover" matters for a resource serving the customer-facing
  application; it does not matter for an isolated test database with no dependents.
- Call `get_audit_history(auditId, scope)` (omit `scope` for a `deep` request, to see history
  across every resource type) to check this audit subscription's *prior* findings: has this exact
  issue existed for multiple audits unresolved? That is worth surfacing explicitly ("open for N
  audits, not yet fixed") — a growing/stale finding is more valuable to report clearly than a
  same-severity brand-new one. If `get_audit_history` returns nothing relevant (e.g. this is the
  subscription's first audit), that's a normal empty result, not a gap — only record a `data_gaps`
  note (Stage 5) if the TOOL CALL ITSELF fails, not just because history happens to be short.

## Stage 5 — Verify, then report only what matters

Before calling `save_analysis`:

1. **Refute every Critical.** For each Critical-severity candidate (especially every chain finding
   from Stage 3), re-read the actual data again and actively try to prove yourself wrong — is
   there a private endpoint elsewhere in the data you missed? Is that "public" IP actually
   unattached? Is the "production" tag actually on a decommissioned resource? If the finding
   doesn't survive this check, downgrade it (to Warning/Info) or drop it entirely. Do not skip this
   step to save time — a false Critical is worse than a missed one, since it is what destroys trust
   in the whole system.
2. **Prefer few, well-evidenced findings over many shallow ones.** The target output for a `deep`
   run is a short list — typically a handful of Stage 2/3 findings that survived verification, each
   with full evidence and a clear "why this matters" — followed by the routine checklist-level
   findings below them (still real, just not headline). A `deep` run on a genuinely healthy
   subscription correctly reports few or no headline findings; do not manufacture significance to
   fill space.
3. **Record what you could not check.** If, at any stage, you needed data that wasn't in what
   `get_audit_data` returned (e.g. a managed identity's role assignment target you couldn't
   resolve, usage data missing for a resource you wanted to correlate cost against), pass it as a
   short string in `save_analysis`'s `data_gaps` array (spec 10 §5.4/§6) — this is what turns into
   the next round of extractor work. Do not silently skip a chain because data was missing; say so.
4. Call `save_analysis` with the final findings (Stage 2/3 headline findings marked
   `finding_type: "chain"`, ordinary findings after), `fix_effort` set on every finding, and
   `data_gaps` populated if step 3 found any.

## What NOT to do

- Do not report a chain finding as several separate single-resource findings — that defeats the
  entire point of Stage 3.
- Do not assign Critical because a finding is security-related; assign it because Stage 4's
  business-context check and Stage 5's refutation both hold up.
- Do not skip Stage 1 to save time — judging severity in Stage 4 is not possible without the
  environment map.
- Do not fabricate a cost figure in Stage 2 — if usage data isn't available for a resource, note
  the gap (Stage 5.3) instead of guessing a number.

## Addendum — new data available since 2026-07-12 (spec 11, round 1 of the data_gaps loop)

Your earlier runs' `data_gaps` reports were turned into collector enrichments. Audits collected
after 2026-07-12 include the following — use them; do not re-report these as gaps:

- **appservice / functions** — per site: `security_config` (minTlsVersion, ftpsState,
  http20Enabled, cors, publicNetworkAccess, ip_security_restrictions, scm_ip_security_restrictions),
  `auth_config` (Easy Auth enabled, unauthenticated_client_action, enabled_providers),
  `app_setting_names` (names ONLY — values are never collected) and `keyvault_reference_count`.
  A `DB_PASSWORD`-style setting name with keyvault_reference_count near 0 is plaintext-credential
  evidence for Stage 3 chains. The site envelope's `identity` block (managed identity principalId)
  is in the list payload — correlate it against IAM assignments and Key Vault access policies.
- **appservice metrics** — the site-level HTTP metrics bug is fixed (interval was missing; errors
  were silently reported as zeros). Zeros accompanied by no `metrics_error` field are now REAL
  zeros and safe to use for idle-app findings; if `metrics_error` is present, treat as unknown.
- **storage** — per account: `containers` (name + public_access + last_modified, capped at 50 with
  `containers_truncated`), exact `total_containers` / `containers_public` counts, and
  `lifecycle_policy` (explicit `null` = CONFIRMED no policy, vs. field absent = not collected).
- **appserviceplan** — `sites_hosted` (real derived count; ARM's `numberOfSites` is unreliable and
  kept only for comparison) and `hosted_site_names` (capped at 20).
- **keyvault / cognitiveservices** — `diagnostic_settings` per resource (enabled log categories +
  destinations); empty array = confirmed nothing configured.
- **new scope `inventory`** — envelope-only list of EVERY resource in the subscription (type
  counts + name/type/location/resourceGroup/tags). Use it in Stage 1 for the environment map and
  before concluding a resource group is empty — it covers the types that have no dedicated scope
  (Front Door, DNS zones, VNets, Log Analytics, NAT gateways, ...).
- **cost** — now 90 days of daily history (was 30), enough to distinguish a longstanding spend
  pattern from a recent change in Stage 4 trend judgment.

Every per-resource enrichment is best-effort: a failed sub-fetch records an `*_error` string field
on that entry. An `*_error` field means "not collected" — still a legitimate `data_gaps` entry —
whereas an empty list/explicit null means "confirmed absent". Known remaining gaps that are NOT
collectible by the CLI (do keep reporting them so their demand is measurable): principal-ID →
directory-name resolution, sign-in/activity logs, Key Vault secret metadata (data-plane), ACR
vulnerability scan results (needs Defender for Cloud).

## Addendum 2 — round-2 fixes (2026-07-12, spec 11 round 2)

- **VNet integration was never actually missing.** `virtualNetworkSubnetId` has always been present
  on each App Service's own `properties` (in the `appservice`/`functions` scope data), not on the
  `appserviceplan` scope. Check the SITE's data for this field, not the plan's — do not re-report
  this as a gap.
- **New scope `cdn`** — every CDN/Azure Front Door profile, each enriched with its `endpoints`
  (hostname, enabled state) and each endpoint's `routes` (custom domains, forwarding protocol,
  HTTPS redirect state), plus `security_policies` (WAF policy ID attached + associated domain
  count). Use this instead of treating CDN/Front Door as opaque inventory entries.
- **`cosmosdb` scope now includes `ru_pricing_by_region`** — real Azure Retail Prices API rates
  (provisioned/autoscale per-100-RU-hour, serverless per-million-RU) for every region an account
  is deployed in. Use this to compute an actual dollar figure for provisioned-vs-autoscale-vs-
  serverless comparisons instead of only pointing in a direction — a missing region in this map
  means pricing wasn't available for that SKU/region combination, not a collection failure.

The following three items were reviewed and are **intentionally not addressed by the collector**;
do not expect them to disappear from future `data_gaps`, and do not treat their persistence as a
bug:

- **App Settings 403** (`appservice`/`functions`/`keyvault` scopes) — reading actual application
  setting values requires an elevated Azure role beyond the audit service principal's Reader
  access, which the project owner has not yet granted (a deliberate access decision — the same
  call also exposes real secret values, not just names). Keep reporting this gap; its continued
  presence is the intended signal for when/whether that grant happens.
- **Principal display-name resolution** (`iam`, `keyvault` scopes) — requires Microsoft Graph API
  access with directory-read consent, not yet granted. This is the confirmed Step B (§6) backlog
  item with the most repeat citations; keep citing it.
- **Blob content inspection** (`storage` scope) — reading actual blob contents to verify what data
  a publicly-readable container holds is a deliberate non-goal, not a missing extractor: the
  contents could be sensitive business or customer data, and reading it is a privacy decision
  outside an automated audit's mandate. Continue recommending a manual sample check by a human
  instead of attempting to read content yourself.

## Addendum 3 — round-3 fixes (2026-07-12, spec 11 round 3)

- **`appserviceplan.sites_hosted` was already correct — read it before concluding anything about
  `numberOfSites`.** A prior run reported "`numberOfSites` is 0 for all plans, contradicting the
  appservice data" as a gap, even though **that exact contradiction was already resolved** on the
  very same `appserviceplan` entry: `sites_hosted` (an integer) and `hosted_site_names` (the actual
  app names) are the derived, correct answer, sitting right next to `properties.numberOfSites` on
  every plan object. Do not cross-reference the `appservice` scope's `serverFarmId` yourself to
  work this out, and do not report this as a gap — the derived fields exist specifically so you
  don't have to.
- **New scope `vm`** — every Virtual Machine, full config plus `power_state` (running/deallocated/
  stopped — not on the base resource, fetched separately). This scope did not exist before round 3;
  a prior `inventory`-scope gap caught a real VM with an active cost line that no extractor tracked.
  A new checklist applies to this scope (idle-but-costing, oversizing, public exposure, missing
  managed identity/encryption/patch signal) — treat it like any other resource type from here on.
- **`cdn` scope's `custom_domains` are now real hostnames**, not resource IDs (e.g.
  `"app.sifma.org.sg"`, not `/subscriptions/.../customDomains/xyz`) — match these directly against
  a Key Vault or App Service's own hostname/domain data to confirm a public-endpoint-to-secret
  chain, instead of noting you couldn't correlate them.
- **`cdn` scope's `security_policies[].waf_policy_mode`** is now populated (`Prevention` or
  `Detection`) — a WAF policy in `Detection` mode is logging only, not actually blocking traffic;
  factor this into severity the same way you would an NSG rule that looks restrictive but isn't
  actually enforced.
- **`cognitiveservices` scope now includes per-account `metrics`** (`total_calls`,
  `successful_calls`, `total_errors`, 30-day) — use this for the pricing-tier-fit and unused-account
  checklist items instead of reporting call volume as unavailable.
- **`functions` scope now includes per-app `functions[]`** — each function's `trigger_type` and
  `auth_level` (`anonymous`/`function`/`admin`). An HTTP-triggered function with `auth_level:
  "anonymous"` is callable with no key at all; use this instead of treating callability as
  unconfirmable. (App Settings 403 is unrelated and separate — still open, still expected.)
