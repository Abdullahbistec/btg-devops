# Spec 13 — Per-resource-type parallel agents for the analyzer (idea, not yet implemented)

> Status: **design finalized and prototype-validated (spec 15 tasks B1–B7 done).** Read
> `spec/agent/deep-research-playbook.md` and `spec/handoff/08-mcp-claude-orchestrator.md` first —
> this proposes changing HOW that playbook gets executed, not what it checks for. Both prompts are
> drafted in full: `spec/agent/parallel-per-type-agent-prompt.md` (B3) and
> `spec/agent/parallel-synthesis-agent-prompt.md` (B4). The two supporting MCP tools are built
> (B6). A live prototype against a real historical audit (B7) confirmed the core value proposition:
> see §"B7 prototype results". Next: B8 (cutover) and B9 (playbook split).

## The current setup (baseline this idea would change)

Today, one Claude Code agent — the hosted scheduled routine `btg-devops-mcp-analyzer`
(`trig_016EuQk8v8sTJT8oiYrHbJau`) — runs the entire 5-stage deep-research playbook sequentially
for a given `analysis_request`, covering all resource types in that scope itself, then calls
`save_analysis` once at the end. `dashboard/app/api/utils/analyzerRoutine.ts` fires this routine
immediately on a manual Analyze click (instead of waiting for its daily cron) via Anthropic's
`routine-fire` API — this part already ships and isn't changing.

There are 12 resource-type extractors today (storage, IAM, NSG, ACR, CosmosDB, KeyVault, Functions,
PublicIP, AppService, AppServicePlan, CognitiveServices, ResourceGroup), plus `cost`, `usage:<type>`,
`inventory`, and `cdn`/`vm` scopes added since (see playbook addenda).

## The idea

Instead of one agent working through all resource types sequentially in a single long context, run
**12 agents in parallel, one per resource type**, then a **synthesis agent** that does the
cross-resource work and is the only one that writes findings.

Key point clarified during discussion: **one resource type per agent**, not resource types grouped
into fewer agents. Each per-type agent is also given the data of *related* resource types (not just
its own) so it isn't blind to obvious neighbors — e.g. the NSG agent also gets Public IP data, the
Storage agent also gets Key Vault + IAM data.

### Why a plain fan-out isn't enough

The playbook's Stage 2 (correlate cost/usage/config across resources) and Stage 3 (chain
low-severity facts from *different* resources into one attack path) are inherently cross-resource.
An agent scoped to only one resource type — even with a few "related" types added — cannot see a
chain that spans resource types outside that group (e.g. CosmosDB + ACR). Something has to see all
12 results together before any finding is finalized.

### Proposed architecture

1. **Phase 1 — 12 parallel agents (a barrier, not a pipeline).** Each agent gets its own resource
   type's audit data plus its related types' data, runs (effectively) Stage 1 for its own scope, and
   returns *candidate* findings as structured data — it does **not** call `save_analysis`.
   `parallel()` is required here (not `pipeline()`): the next phase needs every agent's output at
   once, so waiting for the slowest one is unavoidable — that's the acknowledged cost of getting
   real cross-resource correlation.
2. **Phase 2 — one synthesis agent.** Receives all 12 sets of candidate findings together. This is
   where Stage 2 (correlate), Stage 3 (chain across resource types), Stage 4 (judge severity in
   business context using `get_audit_history`), and Stage 5 (refute every Critical) actually happen
   — the parts of the playbook that need the full picture. **Only this agent calls
   `save_analysis`.**

### Why synthesis, not per-type agents, owns the write

- Stage 5's "refute every Critical before committing" requires full-environment context a
  per-type agent doesn't have — it can't correctly judge severity in isolation.
- 12 concurrent writers to the same audit's findings table would race against the existing
  dedup/auto-resolve logic in `claude.ts` (`findPriorLiveFindings`/`deleteFindingsByScope`), which
  assumes one coherent pass per audit.
- Centralizing the write gives one place to do final cross-resource dedup before anything is
  persisted, instead of relying on post-hoc dedup-by-`resource_type+resource_name+category` to
  clean up overlapping findings from independent agents.

## Benefits discussed

1. **Speed** — 12 resource types analyzed concurrently instead of sequentially; wall-clock roughly
   bounded by the slowest single resource type + the synthesis pass, instead of the sum of all 12.
2. **Consistent depth per resource type** — in a long sequential run, resource types processed last
   risk getting a shorter/lower-quality pass as context grows. Parallel agents each get an equally
   fresh, focused context.
3. **Specialized prompts** — each per-type agent can be scoped to just its own entry in
   `analysisChecklists.ts` instead of one agent juggling all 12 checklists in one prompt.
4. **Fault isolation** — one resource type's agent failing doesn't take down the whole analysis;
   synthesis can proceed with 11 good results and the failure can be logged/retried independently.
5. **Debuggability** — per-type candidate findings become an inspectable intermediate artifact,
   making it possible to tell whether a bad finding originated in the per-type pass or was
   introduced during synthesis.
6. **Cross-resource chaining is preserved** — because of the barrier + synthesis design, this
   doesn't trade away the playbook's core value (Stage 3 chains) for speed.

## Tradeoffs / costs acknowledged

- Total token usage likely goes **up** overall (12 agents + 1 synthesis agent vs. 1 agent), even
  though wall-clock time goes down.
- More implementation/maintenance surface: the routine's prompt needs to orchestrate this (likely
  via the `Workflow` tool's `parallel()` + synthesis pattern), the MCP layer needs a way to fetch
  "related resource type" data per agent, and a new synthesis-stage prompt needs to be written.
- Overlapping findings across per-type agents are still possible pre-synthesis (e.g. two agents
  each flagging the same cross-resource pairing from their own side) — synthesis must dedup before
  writing, not just merge.

## Related-types map (finalized 2026-07-15, spec 15 task B1)

14 of the 15 collected scopes get their own dedicated per-type agent — every one that has an entry
in `analysisChecklists.ts` (storage, iam, nsg, acr, cosmosdb, keyvault, functions, appservice,
appserviceplan, cognitiveservices, resourcegroup, publicip, cdn, vm). `inventory` does NOT get its
own agent — it's explicitly envelope-only/context (per the playbook addenda, "use it in Stage 1 for
the environment map"), so it's folded into universal context instead.

**Universal context — given to every agent, in addition to its own scope's data:**
- `iam` — nearly every Stage 3 chain needs "what identity does this resource have, what role
  assignments exist for that principal" regardless of which resource type started the chain.
- `keyvault` — the most common chain destination (managed identity → access policy → secret); an
  agent that can't see Key Vault data can't recognize when its own resource is a chain's starting
  point.
- `resourcegroup` — Stage 1's environment/naming inference (prod/dev/QA by resource group name)
  applies to every resource type equally.
- `inventory` — broad environment map covering resource types with no dedicated scope (VNets, DNS
  zones, Log Analytics, NAT gateways, Front Door details beyond the `cdn` scope) — needed for Stage
  1 by every agent, not just one cluster.

(`iam`, `keyvault`, and `resourcegroup` are themselves dedicated agents too — as their OWN agent,
each already receives the other two plus `inventory` via the universal rule above; no separate
cluster entry is needed for them.)

**Cluster-specific additions — on top of universal context:**

| Cluster | Members | Each member ALSO gets |
|---|---|---|
| Networking/edge | `nsg`, `publicip`, `cdn` | the other two in this cluster + `appservice`, `functions` (what they expose/protect) |
| Compute/app | `appservice`, `appserviceplan`, `functions` | the other two in this cluster + `publicip`, `nsg`, `cdn` (their public exposure) + `storage`, `cosmosdb` (typical data dependencies) |
| Data | `storage`, `cosmosdb`, `acr` | the other two in this cluster + `appservice`, `functions` (consumers) |
| AI/ML | `cognitiveservices` | `appservice`, `functions` (consumers) |
| Compute (isolated) | `vm` | `nsg`, `publicip` (typical network exposure) — no VMs exist in the currently-audited subscription, kept for completeness per spec 10 §5.5/§6 |

Rationale for the shape: clusters follow the actual Stage 3 chain topology (entry point → identity →
Key Vault → target), not an arbitrary resource-type taxonomy — e.g. `appservice` needs `storage`/
`cosmosdb` because those are its typical data dependencies, not because they're "similarly named."
`iam`/`keyvault` are pulled OUT of any single cluster and made universal because they're the two
scopes almost every chain passes through regardless of which resource type starts it — putting them
in just one cluster would blind every other cluster's agent to the chains that matter most.

## When it triggers (decided 2026-07-15, spec 15 task B2)

**Only `scope === "all"` requests use the parallel fan-out.** Every other scope — a single resource
type, `"cost"`, or `"usage:<type>"` — is analyzed by one agent exactly as today, unchanged.

This falls directly out of how requests actually originate, confirmed in the current code:
- `CLI Engine/cmd/collect.go`'s auto-queue loop (the daily/scheduled path) **never queues `"all"`**
  — it only ever queues individual resource-type scopes plus `"cost"`/`"usage:<slug>"`. So every
  automated daily audit's requests are already single-scope; there's nothing for a 14-agent fan-out
  to parallelize there.
- `"all"` only ever comes from the dashboard's manual Analyze-everything button
  (`analysis-request/route.ts` defaults an omitted/empty `scope` to `"all"`) — the one path
  `runAnalysis`'s own comment already flags as "slower and more expensive, so the frontend gates
  that behind a confirmation dialog." That confirmation dialog is precisely the moment a user is
  explicitly asking for a full, cross-resource-correlated pass over everything — exactly the case
  spec 13's fan-out+synthesis design is for.

A single resource-type request doesn't need 14 agents: the existing `DEEP_RESEARCH_DIRECTIVE`
already tells a lone agent it can call `get_audit_data` again with a different scope as needed for
context (Stage 1), which is sufficient when there's only one resource type's findings to produce.
Spinning up 13 idle-context agents for a one-scope request would add cost with no correlation
benefit — correlation only matters when MULTIPLE resource types' results need to be judged together
at the end, which is exactly the `"all"` case.

### How this plugs into the existing routine/MCP contract with zero schema changes

Today, the routine claims ONE pending `analysis_requests` row via `get_audit_data(auditId, scope)`
and calls `save_analysis(auditId, scope, ...)` once. Since `"all"` is already a single row, the
cleanest implementation needs no new Postgres schema or `analysis_requests` plumbing at all: when
the top-level agent (the one Claude Code routine invocation that claimed the `"all"` request) sees
`scope === "all"`, its playbook instructs it to use the `Workflow` tool itself — spawning the 14
per-type agents in `parallel()`, then one synthesis agent — and the TOP-LEVEL agent is still the one
that calls `save_analysis(auditId, "all", mergedFindings)` at the end, exactly matching today's
one-call-per-request contract. Phase B is therefore mostly a **playbook/prompt change** (B4/B9), not
new backend infrastructure.

### Interaction with spec 14 (cache) — noted for B5, not decided here

Because Go's auto-queue never touches `"all"`, per-scope `cache_hit` is currently only computed for
single-resource-type requests (see `createAnalysisRequestController`'s `scope !== 'all'` guard).
Once B5 (orchestration) is designed, worth revisiting whether the `"all"` fan-out should check each
of its 14 sub-scopes' cache status too — skipping the agent for any scope that's still a cache hit
and feeding synthesis its carried-forward findings alongside the freshly-analyzed ones. That's the
"multiply" effect spec 14 already flagged (a typical day becomes "2 changed scopes → 2 agents +
synthesis; 12 carried forward") — real savings, but it's an orchestration-layer decision, not a
triggering-condition one, so it's deferred to B5.

## Orchestration (decided 2026-07-15, spec 15 task B5)

The top-level agent that claims an `"all"` request runs this shape (pseudo-code — the real
implementation is a `Workflow` script the agent authors inline, per B2):

```
// 1. Find out which of the 14 resource-type scopes actually need an agent.
//    Requires a new MCP tool (B6) — "all" requests never went through the
//    per-request cache_hit column (spec 14 explicitly skips scope="all"),
//    so this is a fresh, read-only hash comparison against every resource-
//    type scope at once, independent of analysis_requests rows.
const status = await list_changed_scopes(auditId)   // [{scope, changed}, ...] — new MCP tool (B6)

// 2. Cached scopes: pull the prior audit's analysis directly — no agent
//    spawned for these at all. Also a new MCP tool (B6), wrapping the same
//    getAnalysisForScope(prevAuditId, scope) lookup utils/analysisCache.ts
//    already uses, so the agent never needs to know a prior audit ID.
const cached = await Promise.all(
  status.filter(s => !s.changed).map(s => get_cached_scope_analysis(auditId, s.scope))
)

// 3. Changed scopes: one per-type agent each, in parallel — a barrier,
//    since synthesis needs every one of them before it can start.
const changedScopes = status.filter(s => s.changed).map(s => s.scope)
const perTypeResults = await parallel(changedScopes.map(scope => () =>
  agent(perTypeAgentPrompt(scope, relatedScopesFor(scope)))  // spec 13's related-types map
    .catch(err => ({ scope, error: String(err) }))           // fault isolation — see below
))

// 4. Synthesis — sees both the fresh per-type results AND the carried-
//    forward cached ones, clearly labeled which is which.
const synthesisInput = [
  ...perTypeResults.filter(r => !r.error),
  ...cached.map(c => ({ ...c, carried_forward: true })),     // tells synthesis not to re-refute
]
const dataGaps = perTypeResults.filter(r => r.error).map(r => `${r.scope}: agent failed — ${r.error}`)
await agent(synthesisAgentPrompt(synthesisInput, dataGaps))  // calls save_analysis itself
```

Key decisions this locks in:

- **Cached scopes never get an agent spawned for them at all** — this is the real payoff of
  combining spec 14 and spec 13: a typical `"all"` run might spawn 2–3 agents instead of 14, with
  the rest pulled from the prior audit's already-saved analysis. This closes the gap flagged in B2
  ("all" requests didn't previously interact with the cache at all).
- **Carried-forward scopes are marked `carried_forward: true`** going into synthesis, not silently
  merged in as if freshly analyzed — synthesis's Stage 5 refutation effort should focus on what's
  actually new; a carried-forward finding was already refuted in whatever prior audit's synthesis
  pass originally produced it. (The A5 staleness ceiling still forces a real per-type agent
  periodically regardless, so this can't silently go stale forever.)
- **Fault isolation**: a per-type agent that throws/errors doesn't stop the run — it's caught,
  turned into a `data_gaps` entry naming which scope failed and why, and synthesis proceeds with
  whatever the rest returned. An audit with 2 of 14 changed scopes where 1 agent fails still
  produces a complete-enough report for the 13 other scopes, not a total failure.
- **`parallel()`, not `pipeline()`, for the per-type agents** — same reasoning as the original
  design: synthesis is a genuine barrier, it needs every changed-scope agent's result before
  Stage 2's cross-type correlation can run.

## B7 prototype results (2026-07-15) — validates the core design

Ran the actual 11-agent fan-out + synthesis (per B3/B4's prompts) against one real historical audit
(the most recent completed audit with existing per-scope analyses, 2026-07-14), comparing the
result to that audit's already-saved analyses. **Names/IDs below are redacted/generalized — the
real run touched actual client resource names, domains, and principal IDs that must never appear in
a committed spec file** (see project memory's redaction rule). Raw prototype data and full agent
outputs stay in a local scratchpad only, never committed.

**Setup simplification** (documented, not a design change): per-type agents read pre-fetched
`{data, instruction}` JSON files (one per scope, fetched once via the real `getScopedAuditData`
function) instead of calling a live `get_audit_data` MCP tool — this session isn't connected to the
dashboard's own MCP server. The data and instructions are byte-identical to what the real tool
returns; only the transport differs (Read a file vs. an MCP tool call). Cache-integration
(`list_changed_scopes`/`get_cached_scope_analysis`, B5/B6) was NOT exercised — no historical audit
has `scope_hashes` yet since that column was only added today, so there's no valid before/after pair
to test cache hits against. That remains for a future prototype once at least two audits exist with
hashes.

**Quantitative result — this is the headline finding:**

| | Existing baseline (11 isolated single-scope analyses) | Prototype (11 agents + synthesis) |
|---|---|---|
| Total findings | 27 | 19 (after synthesis dedup, from 55 raw per-type candidates) |
| Chain findings (`finding_type: "chain"`) | **0** | **5** |
| Severity mix | 4 Critical / 14 Warning / 9 Info | 1 Critical / 13 Warning / 5 Info |

**Zero chain findings in the existing baseline is expected, not a flaw in those old analyses** —
each was a genuinely isolated single-resource-type request with no cross-scope correlation, so a
multi-resource attack path was structurally impossible to detect. The prototype's 5 chain findings
are real, evidence-backed, cross-scope correlations that cite specific fields from multiple
scopes' actual data (e.g. one chain traced a single CI/CD service principal's subscription-wide
Contributor role together with a direct Key Vault access policy grant, correctly flagged Critical;
another traced a public-facing production web app's managed identity through to Key Vault secret
access and container registry push rights; a third correctly downgraded a similar-looking dev-
environment exposure to Info after noticing RBAC — not legacy access policies — was already in use
there, showing Stage 4's "judge in context" reasoning worked, not a blanket rule). This is exactly
spec 13's core value proposition working as designed.

**Other observations:**
- Synthesis correctly resolved several `chain_hints` from per-type agents into full chains using
  another agent's data, and correctly left unresolvable hints as `data_gaps` instead of guessing —
  the design's chain-hint mechanism worked as intended.
- The severity mix shifting from 4 Critical (baseline) to 1 Critical (prototype) reflects Stage 5
  refutation actually happening — synthesis re-examined and downgraded findings that didn't survive
  scrutiny, rather than accepting per-type agents' provisional severities at face value.
- Dedup worked: 55 raw per-type candidates → 19 final findings, with no duplicate/near-duplicate
  findings observed in the merged output.
- Cost: 12 agents, ~985K subagent tokens, ~8.5 minutes wall clock for this one audit. **Follow-up
  measurement (2026-07-15):** since no production `"all"` run exists for this subscription to
  compare against, ran one single-agent "old method" pass — same 11 scopes' data, same instruction
  text (the real production `"all"`-scope instruction + 5-stage directive), one continuous agent,
  no split — as a real baseline. Result: **169,842 tokens, ~3.5 min wall clock, 19 findings, only 1
  chain finding (a cost/reliability chain, not identity/security), 0 Critical.** So the parallel
  method costs **~5.8x more tokens**. But the more important result: the old method had the *exact
  same* IAM/Key Vault/App Service data open in its single context and still produced **zero** of the
  5 identity/security chains the parallel method found — it even flagged the same over-privileged
  service principal as a plain Warning without ever connecting it to that principal's direct Key
  Vault access policy grant, missing the "one leaked credential reaches production secrets" chain
  entirely despite having both files in the same pass. This reframes the cost tradeoff: it is not
  "pay 5.8x more for the same result, just faster" — it is "pay 5.8x more to catch attack paths a
  single sweep structurally tends to miss even with equal data access," which is a materially
  different, and more favorable, case for the design than a pure speed argument would suggest.
- Fault isolation was NOT exercised — all 12 agents succeeded. A deliberate failure-injection test
  (e.g. a scope with intentionally malformed data) is still open for later validation.

**Verdict: the architecture works as designed and the value proposition is confirmed** — cross-
resource chain detection that the current single-scope-request pattern cannot produce at all,
without a token cost that's disqualifying for the "all" button's already-acknowledged expense.
Recommend proceeding to B8 (cutover) once B9 (playbook split) is written.

## Open questions / not yet decided

- Concrete MCP tool changes needed for `list_changed_scopes`/`get_cached_scope_analysis` (B6) — the
  exact schema and how they reuse Phase A's existing hash-comparison/carry-forward logic without
  duplicating it. **Update:** B6 is now implemented (see spec 15) — this line kept for history; the
  remaining open question is validating it against a real changed/unchanged audit pair (needs two
  audits collected after today's `scope_hashes` migration).
- Fault-isolation path is unvalidated — B7's prototype run had zero agent failures to observe the
  `data_gaps`-on-failure behavior in practice.
- What the synthesis agent's exact prompt looks like — likely a condensed version of playbook Stages
  2–5, rewritten to consume 12 structured candidate-finding sets instead of raw audit data directly.

## Next steps (not started)

Draft the MCP tool changes and the synthesis prompt, then prototype against one past audit's data
before touching the production routine's prompt.
