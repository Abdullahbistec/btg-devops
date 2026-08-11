# Spec 9 — Improving Analyze/Chat recommendation quality (future work, not yet built)

> Status: **idea backlog, not scheduled.** Nothing in this file has been implemented. Written to
> capture options discussed so they aren't lost, and to be picked up whenever recommendation
> quality becomes the priority. Read `08-mcp-claude-orchestrator.md` first — this spec assumes
> that architecture (MCP server + scheduled Claude Code agent for Analyze) is in place.

## Why this exists

The current Analyze/Chat prompt (`dashboard/app/api/utils/claude.ts`, `getScopedAuditData` /
`analyzeWithLLM`) works, but it is a single generic instruction per scope with no organization-specific
context: no cost thresholds, no environment conventions (prod vs. dev resource groups), no memory
of what's already been dismissed as a false positive, and no fields beyond
severity/category/issue/recommendation. This is a reasonable v1, but there's real headroom to make
findings more accurate and more actionable.

## Options, roughly cheapest → most involved

### 1. Sharper, org-specific instructions per scope
Today's instruction is generic: *"Analyze the storage resources... as a senior DevOps engineer
would. Find all problems..."* (`claude.ts:238`). Replace with concrete, organization-specific
rules, e.g.:
- Explicit thresholds — "flag any Public IP unattached for more than 7 days", "flag Cosmos DB
  provisioned RU/s more than 3x the 30-day peak usage"
- Environment conventions — which resource-group naming/tags mean prod vs. dev/test, so a
  sandbox resource isn't flagged with the same severity as a production one
- Known acceptable patterns specific to this org's setup

**Effort:** prompt-text only, no schema or code changes. **Highest payoff for lowest cost** — do
this first.

### 2. Richer finding fields
Add fields beyond the current `severity / category / resource_type / resource_name / issue /
recommendation` shape (`AnalysisFinding` in `claude.ts:10-17`):
- `estimated_monthly_savings` — makes cost findings actionable at a glance
- `confidence` — lets the UI visually distinguish "certain" vs. "worth checking" findings
- A direct resource link/ID for one-click navigation from a finding to the resource

**Effort:** schema change (`findingSchema` in `mcp/tools.ts`, `AnalysisFinding` in `claude.ts`) +
prompt change + frontend rendering update (`AnalysisPanel.tsx` and wherever findings render).

### 3. Learn from dismissals
When an analyst dismisses a finding (`findings.status = 'dismissed'`, see `saveFindings` in
`claude.ts:143-180`), the *reason why* isn't captured or fed back anywhere today. Two follow-ups:
- Add a `dismissal_reason` column/field, captured from the UI when a finding is dismissed
- Feed prior dismissals (with reasons) into the prompt as context, so the same false positive
  doesn't get re-flagged on every subsequent audit

**Effort:** DB column + UI capture + prompt change to include dismissal history. Directly reduces
alert fatigue if false positives are a recurring complaint.

### 4. Multi-pass reasoning in the Claude Code agent
Because Analyze now runs as a **Claude Code agent** (via MCP, not a single stateless API call —
spec 8), it's no longer limited to one-shot reasoning. It could, before calling `save_analysis`:
- Cross-check cost and usage data together for the same resource instead of analyzing each scope
  in isolation
- Reconsider/verify a Critical-severity finding with a second pass before committing to it
- Look at the audit's own finding history (already available via existing findings, not just the
  current snapshot) to reason about trends, not just point-in-time state

**Effort:** changes how the scheduled agent's own instructions/loop are written (not dashboard
code) — this is a genuinely new capability unlocked specifically by the MCP move, not something
available when Analyze was a single synchronous Anthropic API call.

## Tradeoff to weigh before starting any of these

Every option here makes prompts bigger and/or reasoning slower — even running on Claude
subscription quota rather than metered billing, longer/more multi-pass reasoning consumes more of
the account's Pro/Max usage per run. Worth identifying the actual pain point first — false
positives, missed issues, or recommendations that are too generic — rather than doing all four at
once.

## Suggested order if/when this gets picked up

1. Option 1 (sharper instructions) — cheap, immediate, no schema risk
2. Option 3 (dismissal learning) — directly addresses repeat false positives, the most common
   complaint pattern for this kind of tool
3. Option 2 (richer fields) — once it's clear which extra fields the UI actually needs
4. Option 4 (multi-pass agent reasoning) — highest effort, worth doing once the scheduled Claude
   Code agent itself exists and is stable (see spec 8's still-open item: no agent is configured yet)
