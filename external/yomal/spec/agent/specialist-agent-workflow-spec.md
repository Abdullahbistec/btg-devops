# btg-devops: Specialist Agent Workflow — Implementation Spec

**Purpose:** Replace the single "analyze everything" Claude prompt with a per-resource-type
specialist agent workflow + one synthesizer pass. This doc is the spec to hand to Claude Code
to implement. It assumes the existing architecture: Go CLI → Postgres (Supabase) → Next.js
dashboard → `claude.ts` calling the Anthropic API directly (no MCP).

---

## 1. Why this change

Current setup: one big prompt tries to judge all 12 resource types at once. Result: shallow,
generic findings, weak recommendations, no real chain detection.

New setup: one small focused agent per resource type ("specialist"), each with its own rubric
and its own calibration scenarios (see `analysis-scenarios.md` format already in use). A final
**synthesizer** pass takes all specialist output, merges related findings into chains, and
re-checks severity with full context.

This mirrors how a real cloud security/DevOps review actually works: reviewers check their own
area, then someone does a cross-cutting pass before the report goes out.

---

## 2. Architecture

```
                 ┌─────────────────────────────┐
                 │   getScopedAuditData()      │
                 │   (Postgres → per-type JSON) │
                 └──────────────┬───────────────┘
                                │
        ┌───────────────┬───────┴───────┬───────────────┐
        ▼               ▼               ▼               ▼
  [Storage Agent]  [NSG Agent]    [VM Agent]   ... [Cost Agent]   (12 parallel calls)
        │               │               │               │
        └───────────────┴───────┬───────┴───────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │   Synthesizer Agent    │
                     │  (chain detection,     │
                     │   dedup, re-severity)  │
                     └──────────┬────────────┘
                                ▼
                     Final findings[] → dashboard
```

- **12 specialist calls run in parallel** (`Promise.all`), each scoped to one resource type.
- **1 synthesizer call** runs after, on the combined specialist output.
- Total: 13 API calls per audit run (was 1, but each is far smaller and far more focused).

---

## 3. File structure to create

```
/prompts
  /specialists
    storage.md
    nsg.md
    vm.md
    keyvault.md
    cosmosdb.md
    ...one per resource type
  synthesizer.md
  _shared-principles.md      <- generalizable rules, injected into every specialist prompt

/scenarios
  storage.md                 <- existing analysis-scenarios.md format, per resource type
  nsg.md
  vm.md
  ...

/lib/claude.ts               <- orchestration logic (existing file, gets modified)
/lib/schema.ts                <- findingSchema (existing, reused as-is)
```

Each resource type gets its **own** prompt file and its **own** scenario file. This keeps
storage calibration examples from leaking into how the model judges VMs, Key Vaults, etc.
(See "generalization vs overfitting" note in section 6 — this is exactly why we split.)

---

## 4. Specialist agent workflow (per resource type, per run)

Each specialist agent follows the same 5-stage internal process. This sequence goes inside
every specialist prompt, not just storage:

1. **Context inference** — from tags, resource group names, naming conventions, determine:
   is this prod, staging, sandbox, dev? Is this customer-facing or internal? Does this
   resource likely hold real/sensitive data or test data?
2. **Rule check** — compare the resource's config fields against the resource-type-specific
   checklist (see section 5b for what each checklist needs).
3. **Evidence collection** — for every rule violation, pull the exact field/value that proves
   it. No finding without a quoted config value as evidence.
4. **Severity calibration** — severity = f(environment, data sensitivity, blast radius),
   never the issue type alone. This is taught via the scenario file's `teaching` lines, and
   restated explicitly in `_shared-principles.md` (see section 6).
5. **Structured output** — emit findings in `findingSchema` shape only. No prose commentary,
   no summary paragraph — the synthesizer handles narrative.

---

## 5. Specialist agent prompt template

### 5a. Shared header (identical across all specialist prompts, pulled from `_shared-principles.md`)

```
You are a specialist cloud security/reliability reviewer. You review ONLY {RESOURCE_TYPE}
resources — you do not have visibility into other resource types, and you must not guess
about resources outside your scope.

GENERAL PRINCIPLES (apply these to every issue you find, including ones not shown in the
examples below):
- Severity is a function of (a) environment — prod vs sandbox/dev/test, (b) data
  sensitivity — what's actually stored/exposed, (c) blast radius — what an attacker or
  outage could reach from here. It is NEVER determined by the issue type alone.
- Every finding needs evidence: quote the exact field/value from the input JSON that proves
  the issue. No evidence, no finding.
- If a misconfiguration is likely intentional for this environment (e.g., a sandbox resource
  with no real data), do not flag it as high severity. Say so explicitly as a "considered but
  not flagged" note if useful, but do not invent risk that isn't there.
- The calibration examples below teach a JUDGMENT PATTERN, not an exhaustive checklist. Apply
  the same reasoning to issues you find that are not shown in these examples.
- Output ONLY structured findings matching the schema. No narrative summary — that is a
  separate pipeline stage.
```

### 5b. Per-resource-type body (unique to each `prompts/specialists/<type>.md`)

Each file adds:
```
RESOURCE TYPE: {e.g. Storage Account}

CHECKLIST (Well-Architected Framework aligned):
- [ ] {rule 1, e.g. supportsHttpsTrafficOnly must be true}
- [ ] {rule 2, e.g. public blob access disabled unless justified}
- [ ] {rule 3, e.g. soft delete / versioning enabled for prod data}
- [ ] {rule 4, e.g. replication tier matches workload criticality}
... (specific to the resource type — 5-10 rules per type)

CALIBRATION EXAMPLES:
{inject 3-5 scenarios from /scenarios/<type>.md — rotate which ones are injected per run
 rather than always the same fixed set, to reduce overfitting to specific examples}

INPUT DATA:
{scoped JSON for this resource type only, from getScopedAuditData()}

OUTPUT: JSON array of findings, findingSchema shape, this resource type only.
```

**Note on checklists:** write these once per resource type using the Azure Well-Architected
Framework pillars (Security, Reliability, Cost, Operational Excellence, Performance) as the
source of truth, not ad-hoc guesses. This is the single highest-leverage piece of work in this
whole spec — a good checklist is what turns "sounds smart" into "actually correct."

---

## 6. Guarding against overfitting to examples

Because each specialist only sees a handful of scenarios, there's a risk it learns to
recognize "the shape of the examples" rather than the underlying reasoning. Mitigations,
all of which should be implemented:

1. `_shared-principles.md` states the general rule in plain instruction form (section 5a),
   separate from any example — so the rule doesn't only exist implicitly inside an example.
2. Each resource type's scenario file should cover **multiple different axes**, not just one
   repeated pattern:
   - environment-based severity (prod vs sandbox — the one example we have)
   - data-sensitivity-based severity (same environment, different data type)
   - a pure false-positive trap (looks wrong, is actually the correct/intentional config)
   - a chain example (multi-hop, reported as ONE finding — see section 7)
3. Rotate which 3-5 scenarios get injected per run rather than always injecting the full
   fixed set, once each scenario file has more than ~5 entries.
4. Keep a held-out set of scenarios per type that are NEVER injected into the prompt — used
   only by the test harness to check the agent generalizes rather than memorizes (section 9).

---

## 7. Synthesizer agent workflow

Runs once, after all specialist calls complete.

**Input:**
- All specialist findings (combined array, tagged by resource type)
- Relationship data: which VM sits in which subnet, which NSG applies to that subnet, which
  identity has which RBAC role on which resource, etc. (see section 8 — this must come from
  the Go collector, it doesn't exist in flat per-type data)

**Steps:**
1. **Chain detection** — look for findings across different resource types that connect via
   the relationship data (e.g., NSG allows inbound 0.0.0.0/0 on port 3389 → that NSG applies
   to a VM → that VM has a local admin account with no MFA). Merge connected findings into
   ONE chain finding with a combined severity and a description of the full path, not three
   separate low-severity findings.
2. **Severity re-check** — some findings that were Medium in isolation become Critical once
   the synthesizer sees they combine with another finding (blast radius argument). Re-score
   using the same environment/sensitivity/blast-radius rule as specialists, now with full
   visibility.
3. **Deduplication** — if two specialists flagged overlapping issues on a shared resource
   (rare, but possible at boundaries), merge into one finding.
4. **Final structured output** — same `findingSchema`, plus a `chain_of` field listing the
   original finding IDs that were merged, so the dashboard can show "this is 1 finding built
   from 3 signals."

### Synthesizer prompt template

```
You are the final-review synthesizer for a multi-agent cloud audit. Each of the following
findings was produced independently by a specialist reviewing ONE resource type. You have
the full picture: all findings, plus relationship data showing how resources connect
(network topology, identity/RBAC assignments, resource group membership).

TASKS:
1. Identify findings that form a connected attack/failure path across resource types. Merge
   each such group into ONE finding describing the full chain. Do not keep the original
   fragments as separate findings once merged.
2. Re-evaluate severity for any finding whose real risk only becomes clear in combination
   with another finding (blast radius increases when combined).
3. Deduplicate any overlapping findings on the same resource.
4. Leave standalone findings (no relationship to others) as-is, but you may sharpen the
   recommendation if cross-resource context makes a better fix obvious.

RELATIONSHIP DATA:
{subnet ↔ NSG ↔ VM ↔ identity/RBAC mapping}

FINDINGS TO REVIEW:
{all specialist findings, tagged by resource type}

OUTPUT: final findings[] array, findingSchema shape + chain_of field where applicable.
```

---

## 8. Data requirements — Go collector changes needed

The synthesizer can't detect chains without relationship data. Confirm/add these to the Go
CLI's collection step (this is likely the biggest non-prompt engineering task here):

- Subnet → NSG association
- NSG → which resources/subnets it applies to
- VM/resource → subnet membership
- Identity (managed identity / service principal / user) → RBAC role assignments → scope
- Key Vault → which identities have access policies/RBAC on it
- Storage account → which identities/networks have access

If these relationships aren't already flattened into the Postgres schema, add a lightweight
`resource_relationships` table: `(source_resource_id, relationship_type, target_resource_id)`.
This is what `getScopedAuditData()` needs to expose for the synthesizer call.

---

## 9. Test harness integration

You already have the scenario file format (`analysis-scenarios.md`) doing double duty as
few-shot examples + answer key. Extend it:

- One scenario file per resource type, same format, living in `/scenarios/<type>.md`.
- Harness runs: feed `input` → specialist agent → check output against `expect.must_find`
  and `expect.must_not_find`.
- Keep 1-2 scenarios per type marked as **held-out** (never injected as few-shot examples,
  only used for scoring) to measure generalization, not memorization.
- Add a synthesizer-level test: a scenario spanning 2+ resource types with a known chain,
  to verify chain detection actually merges findings instead of leaving them separate.

---

## 10. Orchestration logic — `claude.ts` (pseudocode for Claude Code to implement)

```ts
async function runAudit(subscriptionId: string) {
  const resourceTypes = ["storage", "nsg", "vm", "keyvault", "cosmosdb", /* ...12 total */];

  // Stage 1: specialists, in parallel
  const specialistResults = await Promise.all(
    resourceTypes.map(async (type) => {
      const data = await getScopedAuditData(subscriptionId, type);
      const scenarios = loadRotatedScenarios(type, { count: 4 }); // section 6, mitigation 3
      const prompt = buildSpecialistPrompt(type, scenarios, data);
      const result = await callClaude(prompt);
      return { type, findings: parseFindings(result) };
    })
  );

  // Stage 2: relationship data for chain detection
  const relationships = await getResourceRelationships(subscriptionId);

  // Stage 3: synthesizer, single call
  const synthesizerPrompt = buildSynthesizerPrompt(specialistResults, relationships);
  const finalFindings = await callClaude(synthesizerPrompt);

  return parseFindings(finalFindings); // findingSchema[]
}
```

---

## 11. Implementation checklist (for Claude Code)

- [ ] Create `/prompts/_shared-principles.md` (section 5a content)
- [ ] Create `/prompts/specialists/<type>.md` for each of the 12 resource types, with
      resource-specific checklist (section 5b) — **write real checklists per WAF pillars,
      don't leave placeholders**
- [ ] Create `/prompts/synthesizer.md` (section 7)
- [ ] Create `/scenarios/<type>.md` for each resource type, starting from the existing
      `analysis-scenarios.md` storage example, adding at least: 1 environment-severity trap,
      1 data-sensitivity trap, 1 pure false-positive trap, 1 chain example per type where
      applicable
- [ ] Confirm/add `resource_relationships` data in Postgres schema + Go collector (section 8)
- [ ] Modify `claude.ts` to run the parallel specialist + synthesizer flow (section 10)
- [ ] Add `chain_of` field to `findingSchema` in `dashboard/app/api/mcp/tools.ts`
- [ ] Extend test harness to run per-specialist scoring + a synthesizer chain-detection test
- [ ] Add scenario rotation logic (pick N of M scenarios per run, not always the same fixed
      set) once each scenario file has more than ~5 entries

---

## 12. What "done" looks like

- Each of the 12 resource types has its own focused prompt + its own checklist + its own
  scenario file.
- A test run against the harness shows the agent catching `must_find` items and avoiding
  `must_not_find` traps, including on held-out scenarios it wasn't shown.
- A cross-resource chain scenario (NSG + VM + identity) produces ONE merged finding with
  correct combined severity, not three disconnected low-severity findings.
- Findings include specific evidence (quoted config values) and recommendation steps with
  effort estimates — not generic advice.
