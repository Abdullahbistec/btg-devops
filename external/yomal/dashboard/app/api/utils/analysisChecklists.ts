// Per-resource-type best-practice checklists (spec 10, Phase 2) — appended to
// the scope instruction in claude.ts's getScopedAuditData for a single
// resource-type scope. Turns "find all problems" into the same systematic
// hunt a senior engineer runs manually, so coverage is consistent between
// audits instead of the model reporting whatever 2-4 things stand out first.
// Derived from the CIS Azure Benchmark and the Azure Well-Architected
// Framework. Keys match resourceMeta.ts / the raw_data keys the Go
// extractors write (cmd/*.go) — keep both in sync if a resource type is
// renamed or added.
//
// Each entry is intentionally a flat list of concrete, checkable questions —
// not prose — so the model can tick through it rather than paraphrase it.
export const CHECKLISTS: Record<string, string[]> = {
  storage: [
    // Each account's own "containers" array (name + public_access + last_modified)
    // and "containers_public" count already resolve this at the CONTAINER level —
    // the account-level allowBlobPublicAccess toggle only says public access is
    // PERMITTED, not that any container actually uses it.
    'Using each account\'s own "containers" field (public_access per container, not just the account-level allowBlobPublicAccess toggle): is any specific container\'s public_access actually "Blob" or "Container" (not "None") and holds real (non-test) data?',
    'Is shared key (account key) authentication still enabled instead of Azure AD-only access?',
    'Is the minimum TLS version below 1.2?',
    'Is soft-delete (blob or container) disabled?',
    // "lifecycle_policy" is on every account: an explicit null means CONFIRMED
    // no policy exists (not "not collected") — use it directly.
    'Using each account\'s own "lifecycle_policy" field (null = confirmed no policy configured): are large/old accounts missing lifecycle management rules (moving cold data to cheaper tiers)?',
    'Is the redundancy tier (GRS/RA-GRS) overkill for a dev/test/sandbox account, or under-provisioned (LRS) for a production one?',
    'Is the network firewall set to "Allow from all networks" (default-allow) instead of restricted to known IPs/VNets?',
    'Is infrastructure encryption or customer-managed keys expected (per naming/tags) but not configured?',
    'Are there containers/accounts with no activity that still incur storage cost (orphaned)?',
  ],
  iam: [
    'Are there Owner or Contributor role assignments directly on individual users rather than via groups?',
    'Are there stale/guest-account role assignments that look inactive or unused?',
    'Is any role assignment scoped at the subscription level when a narrower resource-group/resource scope would do?',
    'Are there custom roles duplicating a built-in role unnecessarily?',
    'Do multiple identities (users, service principals, managed identities) hold the same high-privilege role redundantly?',
    'Are there role assignments referencing a principal that appears deleted/unresolvable?',
  ],
  nsg: [
    'Is any inbound rule open to 0.0.0.0/0 (or "Any") on a sensitive port (22, 3389, 1433, 3306, 5432)?',
    'Are there overly broad rules (wide port ranges) where a narrower rule would suffice?',
    'Is a rule redundant with — or contradicted by — another rule at a different priority?',
    'Are there NSGs with no rules at all (relying entirely on Azure defaults) attached to production subnets?',
    'Is an NSG attached to a subnet/NIC that also has an associated Public IP, compounding exposure?',
    'Are deny rules missing for known-risky management ports on production-tagged resources?',
  ],
  acr: [
    'Is the admin user (basic auth) enabled instead of relying on Azure AD/managed identity for pulls?',
    'Is the registry on the Basic/Standard SKU while used for production images (no geo-replication, no zone redundancy)?',
    'Is content trust/image signing missing for a production registry?',
    'Are there no retention/cleanup policies configured, letting old images accumulate storage cost indefinitely?',
    'Is public network access enabled with no IP/firewall restriction?',
    'Are vulnerability scanning results (if present in the data) showing unaddressed high/critical CVEs in images still in use?',
  ],
  cosmosdb: [
    'Is local auth (account keys) enabled instead of enforcing Azure AD/RBAC-only access (disableLocalAuth)?',
    'Is the account missing IP rules/virtual network rules/private endpoints while publicNetworkAccess is enabled?',
    'Is there only a single region configured for an account that looks production-facing (no automatic failover)?',
    'Is provisioned throughput (RU/s) far above the account\'s actual usage (cross-reference usage data if available)? Use this scope\'s own "ru_pricing_by_region" (real per-100-RU-hour rates) to compute an actual dollar figure for provisioned-vs-autoscale-vs-serverless, not just a direction.',
    'Are keys old/never rotated (if rotation metadata is present)?',
    'Is backup policy set to the minimum retention/periodic mode for a production account?',
    'Is a database/container using manual throughput when autoscale would better match a variable workload?',
  ],
  keyvault: [
    'Is public network access enabled with no firewall/virtual network rule restricting it?',
    'Is soft-delete or purge protection disabled?',
    'Are access policies overly broad (e.g. "All" key/secret/certificate permissions) instead of least-privilege?',
    'Is RBAC-based access control unavailable (still on the legacy access-policy model) for a vault holding production secrets?',
    'Are there secrets/keys with no expiration date set?',
    // "diagnostic_settings" is on every vault: an empty array means CONFIRMED
    // none configured (not "not collected") — use it directly.
    'Using this vault\'s own "diagnostic_settings" field (empty array = confirmed none configured): is diagnostic logging/auditing missing for a vault holding sensitive material?',
  ],
  functions: [
    'Is the function app reachable over HTTP (not HTTPS-only)?',
    // security_config/auth_config/app_setting_names/keyvault_reference_count/
    // functions[] are all inline on every app — use them directly, not a
    // general impression of the app.
    'Using this app\'s own "security_config.minTlsVersion": is the minimum TLS version below 1.2?',
    'Using this app\'s own "functions[].auth_level" (per function, not app-wide) and "auth_config.enabled": is any HTTP-triggered function\'s auth_level "anonymous" (callable with no key at all) on an app that isn\'t meant to be public?',
    'Is the app running on a Consumption/Dynamic plan when its usage pattern (if usage data available) suggests a Premium/dedicated plan would be cheaper or vice versa?',
    'Using this app\'s own "app_setting_names" (setting NAMES only) and "keyvault_reference_count": are there setting names suggesting secrets (PASSWORD, CONNECTION_STRING, API_KEY, etc.) while keyvault_reference_count is 0 or far below the count of such names?',
    'Using this app\'s own "security_config.cors": is CORS configured to allow all origins ("*")?',
  ],
  appservice: [
    'Is the app reachable over HTTP (not HTTPS-only / no HTTP-to-HTTPS redirect)?',
    'Using this app\'s own "security_config.minTlsVersion": is the minimum TLS version below 1.2?',
    'Using this app\'s own "security_config.remoteDebuggingEnabled": is remote debugging left enabled in a production app?',
    'Using this app\'s own "app_setting_names" (setting NAMES only) and "keyvault_reference_count": are there setting names suggesting secrets (PASSWORD, CONNECTION_STRING, API_KEY, etc.) while keyvault_reference_count is 0 or far below the count of such names?',
    'Is the plan\'s SKU (see appserviceplan) mismatched with this app\'s actual traffic (see traffic/usage data if available)?',
    'Using this app\'s own "security_config.cors": is CORS configured to allow all origins ("*")?',
    'Is there no custom domain/TLS binding for an app that looks production-facing, or a binding with an expiring certificate?',
  ],
  appserviceplan: [
    'Is the plan on a Premium/Isolated SKU while every app on it looks like dev/test (by name or resource group)?',
    'Is the plan sized (instance count / SKU) far above what the apps on it actually use (cross-reference usage data)?',
    // This plan JSON's OWN "properties.numberOfSites" field is unreliable (Azure
    // reports 0 for every plan regardless of actual apps) — every plan already
    // carries the CORRECT derived answer as its own "sites_hosted" (int) and
    // "hosted_site_names" (string[]) fields, sitting right next to properties.
    // Use those two fields directly; do not report numberOfSites=0 as a
    // contradiction or as unverifiable — it is already resolved on this object.
    'Using each plan\'s own "sites_hosted" field (NOT "properties.numberOfSites", which is always 0 and unreliable): are there plans with sites_hosted = 0, incurring cost for zero apps?',
    'Is auto-scale absent on a plan with high/spiky traffic (per usage or traffic data)?',
    'Is a Windows plan hosting only Linux-compatible workloads (or vice versa) when a cheaper matching SKU exists?',
  ],
  cognitiveservices: [
    'Is public network access enabled with no restriction for an account handling potentially sensitive input data?',
    // Each account already carries its own 30-day call-volume metrics inline as
    // a "metrics" object ({total_calls, successful_calls, total_errors,
    // period_days}) — this is NOT the same as the separate "usage" scope, and
    // it is always present (a genuine collection failure sets metrics_error
    // instead). Read THIS field; do not report call volume as unavailable.
    'Using each account\'s own "metrics.total_calls" field (not the separate usage scope): is the account on a pricing tier mismatched with its actual call volume, or is total_calls near zero (unused account still incurring cost)?',
    'Are API keys used instead of Azure AD/managed identity authentication?',
    'Is there no diagnostic logging configured for an account processing sensitive content?',
  ],
  resourcegroup: [
    'Are there resource groups with no resources in them at all (leftover, safe to remove)?',
    'Is there no consistent environment/owner tagging, making it unclear which resource groups are production?',
    'Do resource groups mix clearly different environments (prod + dev resources) in a way that risks accidental impact when managing one?',
    'Are there resource groups in a region inconsistent with the rest of the subscription\'s footprint for no apparent reason?',
  ],
  publicip: [
    'Is the public IP unattached (not associated with any resource) and has been for a while — pure wasted cost?',
    'Is a Basic SKU public IP attached to a production resource where Standard (with zone redundancy, stricter default NSG behavior) would be expected?',
    'Is the IP static when the attached resource has no requirement for a fixed address (could be dynamic, marginally cheaper)?',
    'Is the IP attached to a resource that also has a wide-open NSG rule (compounding exposure — cross-reference nsg data)?',
    'Is DDoS protection expected (per tags/environment) but not enabled?',
  ],
  cdn: [
    'Using each profile\'s "security_policies[].waf_policy_mode": is any attached WAF policy in "Detection" mode (logging only, not actually blocking traffic) rather than "Prevention"?',
    'Using each endpoint\'s "routes[].https_redirect": is HTTP-to-HTTPS redirect disabled on any route serving production traffic?',
    'Using each route\'s "custom_domains" (real hostnames): is a production-looking domain NOT covered by any security_policies association (no WAF attached at all)?',
    'Is an endpoint\'s "enabled_state" or a route\'s "enabled_state" "Disabled" while still incurring profile-level cost?',
    'Is the forwarding_protocol "HttpOnly" or "MatchRequest" (not "HttpsOnly") for a route serving a production domain?',
  ],
  // Added spec 11 round 3 — the deep-research agent's own inventory scope
  // caught a live VM with a real cost line that no extractor was tracking
  // until this checklist existed; see spec/handoff/13-round-3-fixes.md.
  vm: [
    'Is power_state "deallocated" or "stopped" while the VM still shows a cost line — wasted spend on attached disks/reserved capacity?',
    'Is the VM oversized for its actual workload (cross-reference usage/cost data if available) — a right-sizing opportunity?',
    'Does the VM have a public IP directly attached (cross-reference publicip/nsg data) with no NSG restricting inbound access?',
    'Is managed identity absent when the VM likely needs to authenticate to other Azure resources (per naming/tags), suggesting credentials might be stored locally instead?',
    'Is disk encryption (at-host or Azure Disk Encryption) missing on a VM tagged/named as production?',
    'Is the VM using an unmanaged disk or an outdated/deprecated VM size series?',
    'Is boot diagnostics disabled, removing a basic troubleshooting/audit signal?',
    'Is the VM missing from any patch-management/update configuration signal present in the data?',
  ],
}

/** Returns the checklist text to append to a single resource-type scope's
 *  instruction, or '' if the type has no checklist yet (keeps unknown/future
 *  types from erroring — they just get the generic instruction only). */
export function checklistForType(resourceType: string): string {
  const items = CHECKLISTS[resourceType]
  if (!items || items.length === 0) return ''
  return `Best-practice checklist — work through EVERY item below before writing your findings (not just the first few that stand out):\n${items.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
}
