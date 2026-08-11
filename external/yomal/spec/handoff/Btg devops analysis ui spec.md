# btg-devops Dashboard — Cosmos DB Analysis Fix Spec

## Context

I inspected the live Analyze view at `/audits/{id}` with the `cosmosdb` resource type selected. This confirmed several bugs and spec violations that need fixing. This document lists exactly what's broken and what the corrected output should look like.

---

## Bug 1 — Duplicate account rendering (highest priority, looks like a data bug to users)

**What's happening now:**

`bisteccareltdprodacc002` renders as its own account card, but a *second* card above it is titled:

```
"bisteccareltdprodacc002 (and all other 4 accounts)"
```

This is a shared/baseline finding (identical config issue across all 5 Cosmos DB accounts) that got rendered using the account name of just one of the affected accounts, with a parenthetical bolted on. The result: the same account name appears twice on the page, which reads as a duplication bug, not a design choice.

**Root cause:** the "shared across all accounts" finding and the "unique to this one account" findings are being merged into the same list and rendered with the same account-card component, instead of being treated as two structurally different things.

**Fix required:**

Split rendering into two distinct sections, never merged:

1. **Shared issues section** — findings where `affected_resources` includes multiple/all accounts. Render these using the Layout 1 style (issue-first header, tags listing affected accounts, "+N more" if the list is long). Never use an account name as the card title for these.

2. **Per-account section** — findings unique to one specific account. Render these using the Layout 2 style (account name as the card title, only accounts with unique findings get their own card).

3. Accounts with **no unique findings** (only affected by the shared issue) get grouped into a single collapsed line at the bottom, e.g. "4 accounts — dev, QA, UAT, preprod — no unique issues". Do not give them empty/near-empty individual cards.

**A given account name must appear as a card title at most once on the page.**

---

## Bug 2 — "no cost data" badge on every finding

**What's happening now:** Every single finding shows a gray "no cost data" pill, including ones that are pure security/reliability issues with no dollar cost. This reads as a broken feature, not a deliberate absence of cost data.

**Fix required:**

Every finding's cost/impact badge must show one of:
- A dollar estimate, if `cost_impact_usd` is populated (e.g. "$155/mo")
- `cost_impact_note` if no dollar value applies but there's a qualitative label (e.g. "security risk", "reliability risk")
- Never the literal string "no cost data" — if neither field is populated, the prompt/schema is the thing to fix, not the UI fallback text. In the meantime, if a hard fallback is truly needed, use "impact not estimated" rather than a phrase that reads as an error state.

The Cosmos DB findings I inspected are all either credential exposure, unrotated keys, or single-region failover — all should map to `cost_impact_note = "security risk"` or `"reliability risk"`, not a dollar figure. Confirm the prompt sent to Claude/Gemini instructs it to classify non-cost findings this way rather than leaving the field null.

---

## Bug 3 — "ACCOUNT-LEVEL" label is redundant noise

**What's happening now:** Every finding on the Cosmos DB page has a tag reading "ACCOUNT-LEVEL". Since 100% of visible findings currently show this exact label, it carries zero information.

**Fix required:** Remove this label entirely. If a future layer needs to distinguish account-level vs child-level (database-level) findings, that distinction should be implicit from which section the finding appears in (Shared/Per-account section vs. a future per-database breakdown), not a repeated tag on every card.

---

## Bug 4 — Fix text renders as one paragraph, not numbered steps

**What's happening now:**

```
"Set disableLocalAuth=true (enforce AAD RBAC-only access, consistent with
the Cosmos DB Operator/Account Reader role assignments already seen in the
IAM audit), and configure networkAclBypass/virtualNetworkRules or ipRules
to restrict access to known app subnets/private endpoints; set
publicNetworkAccess=Disabled where a private endpoint can be used instead."
```

This is one long sentence — hard to scan, doesn't read as actionable steps.

**Fix required:**

`recommendation` must be stored and rendered as an array of short, numbered steps (max 4 steps), e.g.:

```
1. Set disableLocalAuth = true
2. Configure virtualNetworkRules or ipRules to restrict access
3. Set publicNetworkAccess = Disabled once a private endpoint exists
```

If `recommendation` is currently a single TEXT string in the database and API response, this requires:
1. A schema change (`recommendation` column → `TEXT[]` or JSON array)
2. A prompt change telling Claude/Gemini to return recommendations as a JSON array of short imperative steps, not a paragraph
3. A UI change to render each array item as its own numbered line, not a block of text

Do not attempt to split the existing paragraph client-side (e.g. by sentence or semicolon) — this will produce inconsistent results depending on how the LLM phrases things each run. Fix at the source (prompt + schema), not with string parsing.

---

## Target Visual Structure (Cosmos DB example)

```
[Summary bar: resource type, account count, cached badge, ask-about-audit button]
[3 stat cards: Critical / Warning / Info counts]

"Shared issue · identical across all N accounts"
  [One card: issue title, cost/risk badge top-right, affected account tags,
   1-2 sentence explanation, numbered fix steps]

"Per account · X of N have unique issues"
  [One card per account WITH unique findings — account name as title,
   region/environment subtitle, cost/risk badge, one row per unique
   finding with its own numbered fix]

[Collapsed line: "N accounts — [names] — no unique issues"]
```

This same structure (shared-issue section + per-account section + collapsed-healthy-accounts line) should apply to any account-based resource type: Cosmos DB, Storage Accounts, App Service Plans.

---

## Priority Order

| Priority | Fix | Why |
|---|---|---|
| 1 | Split shared-issue vs per-account rendering (Bug 1) | Currently looks like a data duplication bug |
| 2 | recommendation as numbered steps array (Bug 4) | Affects every single finding, highest visual impact |
| 3 | Populate cost_impact_usd / cost_impact_note properly (Bug 2) | "no cost data" everywhere looks broken |
| 4 | Remove "ACCOUNT-LEVEL" label (Bug 3) | Pure noise, quick removal |

---

## Data/Schema Checklist Before Building

Confirm these exist and are correctly populated before implementing the UI fix:

- [ ] `findings.affected_resources` (array) — populated for shared/cross-account findings
- [ ] `findings.recommendation` — changed from TEXT to TEXT[] (or JSON array), with prompt updated to return steps not prose
- [ ] `findings.cost_impact_usd` — populated where a dollar estimate is possible
- [ ] `findings.cost_impact_note` — populated with a qualitative label ("security risk", "reliability risk", etc.) when no dollar value applies — never left null with UI showing "no cost data"
- [ ] Prompt/schema in `claude.ts` (or wherever the Gemini/Claude call is made) explicitly instructs: shared findings → populate `affected_resources`, not one finding per account; unique findings → tied to a single `resource_name` only