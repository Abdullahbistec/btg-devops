# Analysis Scenarios — calibration examples + test-harness answer key

> **Purpose (dual use):**
> 1. **Calibration (few-shot).** A curated subset of these scenarios is rendered into the instruction
>    text the scheduled agent reads (via `getScopedAuditData` in `claude.ts`), so its findings match
>    the *severity calibration, evidence discipline, and recommendation quality* of the examples here
>    — not just the prose rules in the playbook.
> 2. **Test harness (measurement).** Each scenario's `input` is a synthetic audit fixture and its
>    `expect` block is the answer key. A harness feeds the input to the agent and scores the output:
>    did it catch every `must_find`, did it avoid every `must_not_find` (false-positive trap), did it
>    assign the right severity, did it cite real evidence?
>
> Build a scenario ONCE here and it serves both. See `spec/agent/deep-research-playbook.md` for the
> stages and `dashboard/app/api/mcp/tools.ts`'s `findingSchema` for the exact finding field shapes.



## How to write a scenario

Each scenario is one `### Scenario:` block. Fill in every section. The two highest-value kinds are:
- **Calibration traps** — a situation that *looks* Critical but should be downgraded (or vice versa).
  These teach the tie-break rule by example, which prose alone doesn't do well.
- **Chains** — a multi-hop attack path, so the agent learns to report ONE chain finding instead of
  several disconnected ones.

Field meanings:
- `scope` — which analysis scope this exercises (`storage`, `cost`, `usage:cosmosdb`, `all`, ...).
- `input` — a realistic slice of what `get_audit_data` returns for that scope (config + any cost/
  usage/precomputed_signals relevant). Keep it minimal but real — only the fields the finding hinges on.
- `context` — environment/tag/naming facts the agent would infer in Stage 1 (prod vs sandbox, etc.).
- `expect.must_find` — findings a correct analysis MUST produce. Each uses the real finding shape.
- `expect.must_not_find` — the false-positive traps: things a *lazy* analysis would flag but a
  correct one would NOT (with the reason). This is what stops over-flagging.
- `teaching` — one sentence: the single lesson this scenario exists to teach.

---

## Scenarios

<!-- =========================================================================
     FULLY-WORKED EXAMPLE — copy this block's structure for each new scenario.
     This one is a calibration trap: identical misconfiguration, opposite
     severity, decided purely by environment. It teaches Stage 4's core rule.
     ========================================================================= -->

### Scenario: public-storage-container-prod-vs-sandbox

- **scope:** `storage`
- **teaching:** The same misconfiguration is Critical in production with real data and Info in an empty sandbox account — severity comes from environment + impact, never from the issue type alone.

**input:**
```json
{
  "storage": [
    {
      "name": "stgprodinvoices01",
      "resourceGroup": "rg-production-app",
      "location": "southeastasia",
      "properties": { "publicNetworkAccess": "Enabled", "allowBlobPublicAccess": true, "minimumTlsVersion": "TLS1_2" },
      "containers": [ { "name": "invoices", "public_access": "Blob", "last_modified": "2026-07-20T09:00:00Z" } ],
      "containers_public": 1,
      "total_containers": 3
    },
    {
      "name": "stgsandboxtmp02",
      "resourceGroup": "rg-sandbox-test",
      "location": "southeastasia",
      "properties": { "publicNetworkAccess": "Enabled", "allowBlobPublicAccess": true, "minimumTlsVersion": "TLS1_2" },
      "containers": [ { "name": "scratch", "public_access": "Blob", "last_modified": "2025-01-02T00:00:00Z" } ],
      "containers_public": 1,
      "total_containers": 1
    }
  ]
}
```

**context:** `rg-production-app` is production (name + serves the live app). `rg-sandbox-test` is a throwaway sandbox; its one public container holds only stale scratch data.

**expect.must_find:**
```json
[
  {
    "severity": "Critical",
    "category": "Security",
    "resource_type": "storage",
    "resource_name": "stgprodinvoices01",
    "resource_group": "rg-production-app",
    "child_resource_name": "invoices",
    "issue": "A production storage container holding invoice data is publicly readable by anyone on the internet.",
    "evidence": "container \"invoices\" public_access = \"Blob\", account allowBlobPublicAccess = true, publicNetworkAccess = \"Enabled\"",
    "recommendation_steps": [
      "Set the \"invoices\" container access level to Private",
      "Set allowBlobPublicAccess = false on the account",
      "Restrict publicNetworkAccess to known VNets/IPs"
    ],
    "fix_effort": "quick"
  }
]
```

**expect.must_not_find:**
```json
[
  {
    "resource_name": "stgsandboxtmp02",
    "reason": "Same misconfiguration but a sandbox account with only stale scratch data — this is Info at most, NOT Critical. Flagging it Critical is the exact over-flag this scenario guards against."
  }
]
```

<!-- =========================================================================
     ADD YOUR SCENARIOS BELOW THIS LINE, one `### Scenario:` block each,
     following the structure above. Provide them however is easiest (rough
     notes are fine) and they'll be normalized into this format.
     ========================================================================= -->
