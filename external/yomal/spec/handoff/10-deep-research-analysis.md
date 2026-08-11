# Spec 10 — Deep Research Analysis Strategy (agent-driven whole-subscription investigation)

> Status: **agreed, not yet built.** This spec captures the full discussion (2026-07-11) about making
> Analyze output genuinely valuable — real severities, deep researched findings, whole-subscription
> reasoning — instead of shallow per-resource checkbox findings.
>
> Read first: `08-mcp-claude-orchestrator.md` (the MCP + scheduled Claude Code agent architecture
> this builds on) and `09-improve-analysis-quality.md` (the earlier idea backlog this supersedes
> and absorbs).

---

## 1. The problem (as stated by the project owner)

Current Analyze results are "good but not useful enough":

1. **Fake Criticals** — findings marked Critical that are technically valid but trivially fixable
   in minutes. Severity is being assigned by *category* (security = scary = Critical), not by real
   impact and context. The Critical column has cried wolf too often to be trusted.
2. **Too shallow** — each run surfaces only 2–4 obvious suggestions. Coverage is random between
   runs. The genuinely valuable findings — the kind a senior DevOps engineer only finds after
   hours/days of manual research, correlation, and structuring — never appear.
3. **The goal**: use this platform to find the *real valuable issues about the whole subscription* —
   best-practice violations, actual security vulnerabilities, chained problems — the "big problem
   found after a big research effort" class of finding.

## 2. Key decisions made in discussion (all agreed, do not re-litigate)

| Decision | Detail |
|---|---|
| **Quota is NOT a constraint** | Deep research runs 1–2× per day, or weekly — deliberate scheduled runs, never per-click. At that frequency the Claude Pro/Max subscription quota is a non-issue. |
| **Extractors can and will be extended** | If the agent needs data the Go extractors don't currently capture, we extend the CLI. This is our own code — no external blocker. |
| **Two-step "agent + extractor" evolution** | Step A (now): statically enrich extractors for predictable needs. Step B (later): live on-demand drill-down tool, built only for the queries real runs prove are needed. See §6. |
| **Feedback loop via `data_gaps`** | The playbook requires the agent to record every question it could not answer from the data. Those gaps become the extractor backlog and eventually justify Step B. |
| **Deep research is a separate request type** | New scope (`deep`) in `analysis_requests`, distinct from the existing quick per-resource Analyze. Triggered on a schedule (daily/weekly after the audit) and/or a dedicated "Deep Research" button. |
| **Quality over count** | A run that correctly reports "3 quick wins, nothing major" on a healthy subscription is a success, not a failure. The output is a short ranked list of investigated, evidence-backed problems — not a long list of checkbox findings. |

## 3. Part 1 — Baseline quality fixes (the original 4-phase suggestion)

These fix the per-resource Analyze that already exists. They stand on their own AND feed the deep
strategy (the playbook reuses the rubric and checklists).

### Phase 1 — Severity rubric + evidence requirement (prompt-only, highest payoff)
In `getScopedAuditData()` / `analyzeWithLLM()` (`dashboard/app/api/utils/claude.ts`):

- **Severity rubric**, explicit in the prompt:
  - `Critical` — actively exploitable *now*, data exposed to the internet, or bleeding significant
    money *today* (e.g. public blob access on an account with real data; credentials in app settings).
  - `Warning` — real risk/waste but needs another factor to become an incident (no key rotation,
    missing backup, over-provisioned RU/s).
  - `Info` — deviation from best practice with no current impact.
  - Tie-break rule: *"If unsure between two severities, pick the lower. A finding is not Critical
    just because it is security-related."*
- **Evidence requirement**: every finding must cite the exact field/value from the data that proves
  it (e.g. `"publicNetworkAccess": "Enabled"` + `"ipRules": []`). No evidence → don't report it.
  Kills hallucinated/generic findings.
- **Cross-resource nudge**: instruct the model to look for cross-resource patterns even in
  single-scope runs.

### Phase 2 — Per-resource-type best-practice checklists
New file `dashboard/app/api/utils/analysisChecklists.ts` — one concrete checklist (~10–15 checks)
per resource type, derived from CIS Azure Benchmark + Azure Well-Architected, appended to the scope
instruction. Example (storage): public blob access, shared-key auth, TLS < 1.2, soft-delete off,
missing lifecycle rules, redundancy overkill on dev, firewall default-allow.

Effect: the model works through the same systematic hunt every run — consistent coverage, 2–3×
more findings, including non-obvious ones. Biggest single chunk of Part 1 work, but pure prompt
text — zero schema risk.

### Phase 3 — `fix_effort` field + "Quick wins" UI
- New finding field: `fix_effort: 'quick' | 'moderate' | 'complex'`
  (quick = one CLI command / portal toggle; complex = planning/downtime/code change).
- Touches: prompt schema, `findingSchema` (`dashboard/app/api/mcp/tools.ts`), `AnalysisFinding`
  (`claude.ts`), DB migration (`CLI Engine/internal/db/schema.go`), `insertFinding`
  (`dashboard/app/api/models/findings.ts`), `DisplayFinding` (`dashboard/app/lib/findingsLayout.ts`).
- UI: a **"Quick wins"** section — Critical/Warning + quick findings surface first ("fix these 5
  things in the next hour"), separate from long-term projects.
- Directly answers the "it's critical but easily solvable" complaint: severity = impact,
  fix_effort = cost to fix; the UI shows both.

### Phase 4 — Multi-pass verification in the scheduled agent
The agent's instructions (repo-tracked, see §5) require: re-read the evidence for every Critical
and try to *refute* it before committing — anything that doesn't survive is downgraded or dropped.
Only possible because Analyze is an agent (spec 8), not a one-shot API call.

### Deferred from spec 9 (still deferred)
Dismissal-reason learning (spec 9 option 3) — do it after Phases 1–4 + deep research show how much
noise remains.

## 4. Part 2 — The Deep Research Strategy (the 5-stage playbook)

The core new capability. A playbook the scheduled Claude Code agent walks through for a `deep`
request. The agent may call `get_audit_data` as many times as needed (all 12 resource types +
cost + usage) and holds everything in context before judging anything.

### Stage 1 — Build the map (understand before judging)
Fetch everything. Before hunting problems, build a picture of the subscription:
- Environments (infer prod / dev / QA / UAT from names, resource groups, tags)
- Regions in use
- Which resources form one application (app service + database + storage that belong together)
- Where the money goes (top spend from cost data)

### Stage 2 — Correlate datasets (where the hidden money is)
Per significant resource, join **configuration × cost × actual usage** — the join no per-scope
analysis can do:
- Provisioned at X, 30-day peak usage 5% of X → concrete $/month wasted
- Cost but zero usage → orphaned resource
- Premium tier in an environment whose name says dev

### Stage 3 — Chain issues into attack paths (where the real security risk is)
Single findings are commodity; the value is the **chain**:
> App Service with public access + no auth → its managed identity has a Key Vault access policy →
> Key Vault holds prod Cosmos DB keys.

(Originally scoped as a Public-IP → VM → NSG → identity → Key Vault chain — confirmed via `az vm
list` on the live subscription that there are zero VMs in this environment, so chains here always
run through PaaS resources — App Service/Functions/Cosmos DB/Storage — and their managed
identities instead. See §5.5 below.)

Several Info/Warning-level facts combining into one *actual Critical*: an internet-to-production-
data path. Findable only by reasoning across resource types together.

### Stage 4 — Judge in context (is this issue real *here*?)
Weigh every candidate against the Stage 1 map:
- Same misconfiguration: Critical in prod, Info in a sandbox
- "No failover region" matters for the customer-facing app, not a test database
- Compare with previous audits' findings: existed for months? getting worse? (trend, not snapshot —
  needs the history tool, §5.3)

### Stage 5 — Verify, then report few things that matter
- Refutation pass on each top finding (recheck the data; maybe that VM has no public IP after all)
- Save a short ranked list — typically ~3 investigated, evidence-backed, high-value problems with
  the full chain explained and fix steps — then the routine findings below them
- Record `data_gaps`: every question the data couldn't answer (§6 feedback loop)

### Target output (what the user sees at the top of the analysis page)

```
⚠ Investigated finding #1 — Internet-reachable path to production data
App Service "app-billing-api" has publicNetworkAccess: Enabled with no auth
configured → its system-assigned identity holds an access policy on Key Vault
"kv-example-001" (get/list secrets) → "kv-example-001" contains connection
strings for the production Cosmos DB account.
Evidence: [4 data points cited] · Fix: 3 steps · Effort: quick
```

## 5. Components to build

| # | Component | Detail | Blocks on |
|---|---|---|---|
| 5.1 | **Playbook file** — DONE | `spec/agent/deep-research-playbook.md` — the 5-stage instructions the scheduled agent's prompt points at. Versioned in the repo. The heart of the whole spec. | Nothing |
| 5.2 | **`deep` request type** — DONE | `deep` scope handled in `getScopedAuditData` (`claude.ts`, merges full raw_data+cost+usage like "all" but with the playbook instruction); "Deep Research" option + confirm-dialog + running/queued copy added to `AnalysisPanel.tsx`. Reuses the existing scope-store/poll/export/Quick-Wins machinery for free — no new UI plumbing needed beyond the option itself. | Nothing |
| 5.3 | **Audit-history MCP tool** — DONE | `get_audit_history(auditId, scope?, limit?)` in `mcp/tools.ts`, backed by `findSubscriptionFindingHistory` in `models/findings.ts` — returns every finding (any status) across past audits of the same subscription, oldest first; `scope` optional so a `deep` request can see history across every resource type. Stage 4 of the playbook calls this instead of guessing at trends. | Nothing |
| 5.4 | **Chain-finding schema + UI** — DONE | `finding_type` column (`'chain'` \| `'standard'`, `schema.go`) + `data_gaps` on the saved analysis (top-level, not per-finding). A chain reuses existing `affected_resources` (chain's resources in order) and `issue` (hop-by-hop narrative) — `finding_type` only controls rendering. Threaded through `AnalysisFinding`/`ClaudeAnalysis` (`claude.ts`), the MCP `findingSchema`/`save_analysis` input (`tools.ts`), `Finding`/`DisplayFinding` (both `types/index.ts`, `findingsLayout.ts`), and `insertFinding` (`models/findings.ts`). UI: `AnalysisPanel.tsx` renders `finding_type==='chain'` findings as a distinct red-bordered "Investigated finding" headline card above the severity tiles, and any `data_gaps` as a "Data gaps" callout below them (a chain finding still also appears in the regular findings list below, same precedent as Quick wins — filtering the page never hides it entirely). | 5.1 (shape follows playbook) |
| 5.5 | **Extractor enrichment (Step A)** — DONE, no code needed | Audited every extractor (`CLI Engine/internal/extractors/cleaner.go`'s `CleanResource`/`CleanResources`): they only strip 3 top-level noise fields (`etag`, `systemData`, `type`) plus `id`, and do NOT trim nested properties. So NSG security rules, Key Vault access policies, Public IP `ipConfiguration`, and managed-identity blocks (`identity.principalId` on App Service/Functions/ACR/Cosmos DB) are **already fully collected today** — no extractor change was needed for those. The one real gap found: **no VM/NIC extractor exists at all** (confirmed no `armcompute` usage anywhere in the codebase). Confirmed via live `az vm list` against the actual audited subscription that it has **zero VMs** — so this gap is moot for this environment; decision made to skip building a VM/NIC extractor. The playbook (5.1) was updated to build chains through PaaS resources (App Service/Functions/Cosmos DB/Storage + their managed identities → Key Vault) instead of a VM hop. Revisit only if a future audited subscription is confirmed to actually run VMs. | 5.1 |
| 5.6 | **The scheduled agent itself** | Spec 8's still-open final step — the cron'd Claude Code agent is NOT configured yet. Nothing runs automatically until it exists. Must be done regardless. | 5.1–5.3 |

## 6. Agent + extractor evolution (future-proofing)

**Step A — static enrichment (now).** Predict ~80% of what deep research needs, add those fields
to the extractors, next scheduled audit captures them. Fits the existing architecture (CLI collects
→ Postgres stores → agent reads); no new security surface.

**The feedback loop.** The playbook obliges the agent to output `data_gaps` — data it needed but
couldn't get ("couldn't verify Key Vault access — access policies not in audit data"). After a few
real runs, the gaps list tells us exactly which drill-downs matter in practice.

**Step B — live on-demand drill-down (later, only if gaps justify it).** A new MCP tool like
`get_resource_details(resourceId)` that queries Azure live mid-investigation. Two hosting options,
decide when building: (a) MCP server gets Azure credentials (new secret; the MCP server is
internet-reachable — treat like `JWT_SECRET`), or (b) the Go CLI grows a small on-demand endpoint
the MCP server calls. **Do not build Step B speculatively** — build it for the specific queries
`data_gaps` proves are needed.

**Round-1 results (2026-07-12, spec 11).** The first `data_gaps` review happened: 11 of 78
scope-analyses (audits `b9c6e53d`/`3e22f30c`, 2026-07-11) reported gaps. The extractor-fixable
ones (site security/auth config, storage containers + lifecycle, broken site metrics, unreliable
`numberOfSites`, diagnostic settings, missing resource-type coverage, 30-day cost window) were
implemented in spec 11. The following came back as **not CLI-collectible** and form the standing
Step B / permissions backlog — each needs a decision beyond extractor code, so track how often
future runs re-report them before building anything:

| Backlog item | Reported | What it needs |
|---|---|---|
| Principal-ID → display-name resolution (IAM assignments, KV access-policy objectIds) | 2 scopes | Microsoft Graph API + directory-read permission for the audit SP |
| Sign-in / activity logs ("is this broad assignment actually used?") | 1 scope | Entra/activity-log read access; large data volume |
| Key Vault secret metadata (expiry dates, rotation state) | 2 scopes | Data-plane vault access for the audit SP on every vault — a security decision |
| ACR image vulnerability scan results | 1 scope | Defender for Cloud enabled on the subscription — a cost decision |
| App-setting names (`ListApplicationSettings` → 403 on all 23 apps, first spec-11 audit `22d76f89`) | discovered in verification | `Microsoft.Web/sites/config/list/action` for the audit SP (e.g. Website Contributor or a custom role). Extractor code already handles it — grant the permission and names appear on the next audit |

## 7. Build order

1. **Phase 1** (severity rubric + evidence) — prompt-only, improves the very next run
2. **Phase 3** (`fix_effort` + Quick wins UI) — small schema addition, most visible UX change
3. **Phase 2** (checklists) — biggest prompt-text chunk
4. **Playbook** (5.1) + **extractor enrichment list** (5.5)
5. **`deep` scope** (5.2) + **history tool** (5.3)
6. **Chain-finding schema + UI** (5.4)
7. **Configure the scheduled agent** (5.6) — unblocks everything end-to-end
8. **First real deep run** → review `data_gaps` → extractor backlog → (eventually) Step B

## 8. Expected outcomes (how we'll know it worked)

| Metric | Today | Target |
|---|---|---|
| Criticals per audit | many, mostly noise | few, all trustworthy (evidence-backed, context-judged, refutation-survived) |
| Findings per resource type | 2–4, random coverage | 8–15, consistent checklist coverage |
| Deep/cross-resource findings | none | present every deep run (config×cost×usage joins, attack chains) |
| Actionability | prose to interpret | evidence + numbered fix steps + effort label + quick-wins triage |
| Analyst trust | Critical column ignored | Critical column acted on |

## 9. Honest limits (accepted)

- The agent finds only what's in the data — hence §6's feedback loop.
- Deep runs are slow (minutes, multi-fetch, multi-pass). Fine for a scheduled cadence.
- A healthy subscription yields a short report. That is correct behavior.
- Chat remains out of scope (spec 8 decision, unchanged).
