import { findAuditById, updateClaudeAnalysis, findAnalysisById, findAuditCostUsageRaw, findAuditUsageRaw, findAuditCostRaw, findPreviousAuditCostUsageRaw } from '../models/audit'
import { insertFinding, findFindingsByAudit, deleteFindingsByScope, findPriorLiveFindings, deleteFindingsByIds, resolveFindingsByIds } from '../models/findings'
import { ChatMessage, Finding } from '../types'
import { callLLMWithFallback, LLMProvider, LLMMessage } from './llm'
import { buildUsageGroups, resourceTypeSlug } from './usage'
import { checklistForType } from './analysisChecklists'
import { detectZombieSpend, detectSpendSpikes, detectServiceConcentration, detectCostUsageWaste, compareCostPeriods, forecastCost, rollupCostByResourceGroup, rollupCostByTag, detectReservedInstanceCandidates, InventoryDataRaw } from './costInsights'
import { detectIdleResources, compareUsagePeriods } from './usageInsights'
import { CostRow, UsageMetricRaw } from '../types'

const DEFAULT_PROVIDER: LLMProvider = 'claude'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

// Shared severity/evidence rules (spec 10, Phase 1) — appended to every
// scope's instruction in getScopedAuditData, so both the direct-LLM path
// (analyzeWithLLM, below) and the MCP-server/scheduled-agent path (which
// only ever sees the instruction text via get_audit_data, never this file's
// prompt template) apply the same rubric. Kept as one constant instead of
// duplicating it per scope branch to avoid the two paths drifting apart.
export const SEVERITY_RUBRIC = `Severity rubric — apply strictly, do not default to Critical for anything security-related:
- Critical: actively exploitable right now, data exposed to the internet, or bleeding significant money today (e.g. public blob access on an account holding real data; credentials sitting in plain app settings).
- Warning: a real risk or real waste, but it needs another factor to become an incident (e.g. key rotation not enabled, missing backup, RU/s provisioned far above actual usage).
- Info: a deviation from best practice with no current impact.
Tie-break rule: if you are unsure between two severities, pick the lower one. A finding is not Critical just because it is security-related.

Evidence requirement: "issue" is the plain-English problem statement; "evidence" must separately cite the exact field/value from the data that proves it (e.g. "publicNetworkAccess = \"Enabled\", ipRules = [] (empty)"). If you cannot point to a specific field/value proving the issue, do not report it — do not guess or report something generic.`

// Every Analyze request — a single resource type, "all", "cost", or
// "usage:<type>" — follows the same 5-stage deep-research process; there is
// no separate fast/one-shot mode (decision superseding the earlier
// deep-only 'deep' scope). Appended to every branch's instruction in
// getScopedAuditData alongside SEVERITY_RUBRIC.
export const DEEP_RESEARCH_DIRECTIVE = `Follow the 5-stage deep-research playbook at spec/agent/deep-research-playbook.md exactly — do not answer in one pass, even for a narrow scope: (1) build a map of environments/regions/application groupings/spend before judging anything — call get_audit_data again with a different scope (another resource type, "cost", "usage:<type>", or "all") as needed to gather context beyond what this request's own data covers; (2) correlate configuration × cost × usage per resource for hidden-waste findings; (3) chain individually low-severity facts into real attack paths (e.g. a public/no-auth resource's managed identity reaching a Key Vault reaching production credentials) and report each chain as ONE finding with finding_type set to "chain"; (4) judge every candidate's severity against the environment map and get_audit_history's trend data, never from category alone; (5) actively try to refute every Critical before committing to it, then save a SHORT list of well-evidenced findings — record anything you needed but couldn't find as short strings in a data_gaps array. If you cannot read the playbook file, apply this same process from this instruction alone.`

export interface AnalysisFinding {
  severity: 'Critical' | 'Warning' | 'Info'
  category: string
  resource_type: string
  resource_name: string
  // Resource group the affected resource lives in, read straight off the
  // `resourceGroup` field extractors attach to each item (cleaner.go) —
  // lets the UI group findings the same way the Raw Resource Data view
  // groups resources. Optional: "cost"/"usage"/"all"-scope findings don't
  // always map to one resource group, and old cached analyses predate this
  // field entirely.
  resource_group?: string
  // Account-based resource types only (see findingsLayout.ts) — resource_name
  // is the account/plan, this is the specific database/container/app.
  child_resource_name?: string
  // Flat resource types only — when the SAME issue affects multiple
  // resources, every affected resource name goes here instead of creating
  // one finding per resource. Populated by the model directly, never
  // derived after the fact by matching on issue text (wording varies run to
  // run — see findingKey below).
  affected_resources?: string[]
  // Estimated monthly dollar impact. Exactly one of cost_impact_usd /
  // cost_impact_note should be set — a label like "security risk" when the
  // issue has no dollar figure.
  cost_impact_usd?: number
  cost_impact_note?: string
  issue: string
  // Raw field/value proof backing `issue`, shown as its own "why this is
  // flagged" section in the UI instead of folded into the problem sentence.
  // Optional because findings saved before this field existed won't have it —
  // the UI falls back to just not rendering the evidence section for those.
  evidence?: string
  // Legacy flat fix text — derived from recommendation_steps (joined), kept
  // so existing consumers (exports, the summary email, chat context) that
  // read a plain string keep working unchanged.
  recommendation: string
  // The fix as short, numbered steps (max 4) — what the grouped UI actually
  // renders. This is the field the model should populate; `recommendation`
  // above is filled in from this automatically.
  recommendation_steps?: string[]
  // Cost to FIX, deliberately separate from severity (cost of the PROBLEM) —
  // spec 10 Phase 3. A Critical finding can be a one-toggle fix; a Warning
  // can require a migration. Powers the "Quick wins" UI section (Critical/
  // Warning findings that are also cheap to fix, surfaced first).
  fix_effort?: 'quick' | 'moderate' | 'complex'
  // 'chain' marks a deep-research headline finding (spec 10 §4 Stage 3) —
  // several individually low-severity facts reasoned together into one real
  // attack path. Its content reuses the fields above (affected_resources for
  // the chain's resources in order, issue for the hop-by-hop narrative) —
  // this flag only controls rendering: a chain finding gets a distinct
  // headline card at the top of the analysis page instead of blending into
  // the regular list. Absent/undefined means a standard finding.
  finding_type?: 'chain' | 'standard'
}

export interface ClaudeAnalysis {
  summary: string
  findings: AnalysisFinding[]
  generated_at: string
  model: string
  // Data the agent needed but couldn't get from get_audit_data (spec 10 §5.5/
  // §6's feedback loop) — e.g. "couldn't verify Key Vault access — access
  // policies not in audit data". Only meaningful for a 'deep' scope analysis
  // (the multi-stage playbook is what requires recording this); absent for
  // ordinary single-resource-type/"all" analyses.
  data_gaps?: string[]
}

/** claude_analysis JSONB column shape: either the full-audit analysis, or one
 *  analysis per resource type, or both (whichever the user has run so far). */
export interface ClaudeAnalysisStore {
  all?: ClaudeAnalysis
  by_resource?: Record<string, ClaudeAnalysis>
}

// Reads back whatever analysis is currently saved for a scope — used by the
// analysis-request poll endpoint once a request's status flips to 'done'.
export async function getAnalysisForScope(auditId: string, scope: string): Promise<ClaudeAnalysis | undefined> {
  const store = normalizeStore(await findAnalysisById(auditId))
  return scope === 'all' ? store.all : store.by_resource?.[scope]
}

function normalizeStore(raw: unknown): ClaudeAnalysisStore {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  if ('all' in obj || 'by_resource' in obj) return obj as ClaudeAnalysisStore
  if ('findings' in obj) return { all: obj as unknown as ClaudeAnalysis } // legacy flat shape
  return {}
}

function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('no JSON object in Claude response')
  return JSON.parse(candidate.slice(start, end + 1))
}

async function analyzeWithLLM(
  data: unknown,
  instruction: string,
  provider: LLMProvider,
  model: string
): Promise<{ analysis: ClaudeAnalysis } | { error: string; status: number }> {
  let text: string
  let usedProvider = provider
  let usedModel = model
  try {
    const result = await callLLMWithFallback(
      { provider, model },
      [{
        role: 'user',
        content: `Azure audit data (cleaned resource snapshot):
${JSON.stringify(data)}

${instruction}

Respond with ONLY a JSON object in this exact shape, no other text:
{
  "summary": "2-3 sentence overall assessment",
  "findings": [
    {
      "severity": "Critical" | "Warning" | "Info" — must follow the severity rubric above exactly; do not report a finding you cannot justify against it,
      "category": "Security" | "Cost Waste" | "Misconfiguration" | "Governance" | "Performance",
      "resource_type": "one of the resource type keys from the data (e.g. storage, iam, nsg)",
      "resource_name": "the specific resource affected — for account-based types (cosmosdb, storage, appserviceplan) this is the ACCOUNT/PLAN name, not the individual database/container/app. For a finding shared identically across multiple accounts, set this to any one affected account name (it is not shown) and list every affected account in affected_resources instead — never bolt a count or parenthetical onto this field, e.g. never \"acct1 (and 4 other accounts)\".",
      "resource_group": "the resourceGroup field from that resource's data, if present — omit this field entirely if the data has no resourceGroup for it",
      "child_resource_name": "ONLY for account-based resource types (cosmosdb, storage, appserviceplan): the specific database/container/app this finding is about. Omit entirely for every other resource type, for account-level findings that apply to the whole account rather than one child, and for findings shared across multiple accounts.",
      "affected_resources": ["When the exact same issue affects multiple resources — including multiple ACCOUNTS for account-based resource types (cosmosdb, storage, appserviceplan) — list every affected resource/account name here and write ONE finding for the whole pattern instead of one finding per resource/account. Omit this field entirely for issues unique to a single resource/account."],
      "cost_impact_usd": "estimated monthly dollar impact as a number, if this issue has one — omit if not applicable",
      "cost_impact_note": "a short label instead of cost_impact_usd when the issue has no dollar figure, e.g. \\"security risk\\" — always include ONE of cost_impact_usd or cost_impact_note, never omit both",
      "issue": "the problem, in plain English, for a non-technical reader — no raw field names/values here, e.g. \\"This storage account is publicly exposed to the entire internet with no network restriction.\\"",
      "evidence": "MUST cite the exact field/value from the data that proves the issue (per the evidence requirement above), e.g. \\"publicNetworkAccess = \\\\\\"Enabled\\\\\\", ipRules = [] (empty)\\"",
      "recommendation_steps": ["short numbered fix step, imperative, one concrete action per step — max 4 steps, never a paragraph"],
      "fix_effort": "quick" | "moderate" | "complex" — quick means a single CLI command or portal toggle with no downtime; moderate needs some planning/testing; complex needs a migration, downtime, or code change. This is about the cost to FIX, not how bad the issue is — a Critical finding can still be "quick"
    }
  ]
}`,
      }],
      8000
    )
    text = result.text
    usedProvider = result.provider
    usedModel = result.model
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'LLM call failed', status: 502 }
  }

  if (!text) return { error: 'empty response from model', status: 502 }

  let parsed: { summary?: string; findings?: AnalysisFinding[] }
  try {
    parsed = extractJSON(text) as { summary?: string; findings?: AnalysisFinding[] }
  } catch {
    return { error: 'could not parse model analysis response', status: 502 }
  }

  const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).map(f => ({
    ...f,
    // The model only produces recommendation_steps; `recommendation` (the
    // legacy flat string) is derived here so exports/email/chat context
    // that still read a plain string keep working unchanged.
    recommendation: Array.isArray(f.recommendation_steps) && f.recommendation_steps.length > 0
      ? f.recommendation_steps.join('. ')
      : f.recommendation || '',
  }))

  return {
    analysis: {
      summary: parsed.summary || '',
      findings,
      generated_at: new Date().toISOString(),
      model: `${usedProvider}:${usedModel}`,
    },
  }
}

// Cross-audit identity for a finding. resource_type + resource_name +
// category is the most stable signal available — the issue TEXT can't be
// used because the LLM words it slightly differently on every run.
function findingKey(f: { resource_type?: string | null; resource_name?: string | null; category?: string | null }): string {
  const norm = (s?: string | null) => (s || '').trim().toLowerCase()
  return `${norm(f.resource_type)}|${norm(f.resource_name)}|${norm(f.category)}`
}

// Saves one scope's findings with full lifecycle handling:
//
// 1. Replace, don't append: this audit+scope's previous rows are deleted
//    first, so re-analyzing after a cache clear doesn't duplicate.
// 2. Age carry-forward: if the same issue (per findingKey) was already open
//    in an EARLIER audit of this subscription, the new row inherits that
//    row's first_seen_at — so an unfixed problem shows "7 days old" next
//    week instead of resetting to "new" on every audit. The superseded
//    older row is deleted (its audit's cached claude_analysis JSON still
//    preserves what that audit reported, so no display history is lost).
// 3. Sticky dismissals: if the matched prior row was dismissed, the new row
//    stays dismissed — a new audit doesn't resurrect issues someone already
//    marked "won't fix".
// 4. Auto-resolve: prior OPEN issues that no longer appear in this fresh
//    analysis get status='resolved' — the signal that something actually
//    got fixed. (Dismissed ones are left alone.)
async function saveFindings(auditId: string, findings: AnalysisFinding[], scope: string) {
  await deleteFindingsByScope(auditId, scope)

  const prior = await findPriorLiveFindings(auditId, scope)
  const priorByKey = new Map(prior.map(p => [findingKey(p), p]))

  const validSeverities = ['Critical', 'Warning', 'Info']
  const matchedPriorIds: string[] = []
  const newKeys = new Set<string>()

  for (const f of findings) {
    if (!validSeverities.includes(f.severity)) continue
    const key = findingKey(f)
    newKeys.add(key)
    const match = priorByKey.get(key)
    if (match) matchedPriorIds.push(match.id)
    await insertFinding(auditId, {
      severity: f.severity,
      category: f.category || undefined,
      resource_type: f.resource_type || '',
      resource_name: f.resource_name || '',
      resource_group: f.resource_group || undefined,
      child_resource_name: f.child_resource_name || undefined,
      affected_resources: f.affected_resources && f.affected_resources.length > 0 ? f.affected_resources : undefined,
      cost_impact_usd: f.cost_impact_usd,
      cost_impact_note: f.cost_impact_note || undefined,
      recommendation_steps: f.recommendation_steps && f.recommendation_steps.length > 0 ? f.recommendation_steps : undefined,
      fix_effort: f.fix_effort || undefined,
      finding_type: f.finding_type || undefined,
      issue: f.issue || '',
      evidence: f.evidence || undefined,
      recommendation: f.recommendation || '',
    }, scope, {
      status: match?.status === 'dismissed' ? 'dismissed' : 'open',
      firstSeenAt: match ? new Date(match.first_seen_at) : new Date(),
    })
  }

  // Matched older copies are superseded by the rows just inserted.
  await deleteFindingsByIds(matchedPriorIds)

  // Open issues from earlier audits that no longer appear → fixed.
  const disappeared = prior
    .filter(p => p.status === 'open' && !newKeys.has(findingKey(p)))
    .map(p => p.id)
  await resolveFindingsByIds(disappeared)
}

export interface ScopedAuditData {
  data: unknown
  instruction: string
}

// A short line appended to any instruction whose data includes
// precomputed_signals — tells the agent these were computed deterministically
// (spike baselines, zombie-spend diffs, etc.) so it verifies/explains context
// instead of re-deriving the underlying arithmetic itself.
const PRECOMPUTED_SIGNALS_NOTE = 'The data includes a `precomputed_signals` object — these are deterministically computed (not model-generated) facts: cost/usage anomalies, concentration ratios, idle resources, and similar. Treat their numbers as ground truth; your job is to judge severity/context and write the finding, not recompute the math. Exception: `reserved_instance_candidates` is only a STABILITY signal (low variance + high mean daily cost) — before recommending a Reserved Instance/Savings Plan commitment, use other data (e.g. whether the resource looks permanent vs. slated for decommissioning per other findings) to judge whether committing is actually wise.'

// Builds every cost/usage precomputed signal relevant to a scope, omitting
// empty arrays so a quiet subscription doesn't bloat the payload with empty
// lists. costRows/usageMetrics/inventory are each optional because not every
// scope has all three on hand (e.g. "usage:<type>" never loads cost rows).
function buildPrecomputedSignals(opts: {
  costRows?: CostRow[]
  usageMetrics?: UsageMetricRaw[]
  inventory?: InventoryDataRaw | null
  // Previous audit's rows/metrics for the SAME subscription (see
  // findPreviousAuditCostUsageRaw), for audit-over-audit "$X this audit vs
  // $Y last audit" comparisons. Undefined when there's no prior audit yet.
  previousCostRows?: CostRow[]
  previousCostPeriod?: { from: string; to: string }
  previousUsageMetrics?: UsageMetricRaw[]
}): Record<string, unknown> | undefined {
  const signals: Record<string, unknown> = {}

  if (opts.costRows && opts.costRows.length > 0) {
    const zombieSpend = detectZombieSpend(opts.costRows, opts.inventory)
    const spendSpikes = detectSpendSpikes(opts.costRows)
    const serviceConcentration = detectServiceConcentration(opts.costRows)
    if (zombieSpend.length > 0) signals.zombie_spend = zombieSpend
    if (spendSpikes.length > 0) signals.spend_spikes = spendSpikes
    if (serviceConcentration.length > 0) signals.service_concentration = serviceConcentration

    if (opts.previousCostRows && opts.previousCostPeriod) {
      const comparison = compareCostPeriods(opts.costRows, {
        rows: opts.previousCostRows,
        periodFrom: opts.previousCostPeriod.from,
        periodTo: opts.previousCostPeriod.to,
      })
      if (comparison) signals.cost_period_comparison = comparison
    }

    const forecast = forecastCost(opts.costRows)
    if (forecast) signals.cost_forecast = forecast

    const byResourceGroup = rollupCostByResourceGroup(opts.costRows, opts.inventory)
    if (byResourceGroup.length > 0) signals.cost_by_resource_group = byResourceGroup

    const byTag = rollupCostByTag(opts.costRows, opts.inventory)
    if (byTag.length > 0) signals.cost_by_tag = byTag

    const riCandidates = detectReservedInstanceCandidates(opts.costRows)
    if (riCandidates.length > 0) signals.reserved_instance_candidates = riCandidates
  }

  if (opts.usageMetrics && opts.usageMetrics.length > 0) {
    const idleResources = detectIdleResources(opts.usageMetrics)
    if (idleResources.length > 0) signals.idle_resources = idleResources

    if (opts.previousUsageMetrics) {
      const usageComparison = compareUsagePeriods(opts.usageMetrics, opts.previousUsageMetrics)
      if (usageComparison.length > 0) signals.usage_period_comparison = usageComparison
    }
  }

  if (opts.costRows && opts.costRows.length > 0 && opts.usageMetrics && opts.usageMetrics.length > 0) {
    const costUsageWaste = detectCostUsageWaste(opts.costRows, opts.usageMetrics)
    if (costUsageWaste.length > 0) signals.cost_usage_waste = costUsageWaste
  }

  return Object.keys(signals).length > 0 ? signals : undefined
}

// Resolves what to send an LLM (or the MCP-server-driven Claude Code agent —
// see spec 8) for a given scope, and the instruction to send alongside it.
// Pulled out of runAnalysis so the same scoping rules serve both the
// synchronous in-request LLM path AND the async MCP-server orchestrator
// path, without duplicating (and risking drift on) which DB column/branch
// each scope reads from.
export async function getScopedAuditData(auditId: string, scope: string): Promise<ScopedAuditData | { error: string; status: number }> {
  const audit = await findAuditById(auditId)
  if (!audit) return { error: 'audit not found', status: 404 }

  // Every scope always gets DEEP_RESEARCH_DIRECTIVE + SEVERITY_RUBRIC —
  // there is no separate fast/one-shot mode (decision superseding the
  // earlier standalone 'deep' scope; 'deep' is kept as an accepted alias of
  // 'all' below purely so any already-saved analyses/requests from before
  // this change still resolve, not because it's offered anywhere anymore).
  if (scope === 'all' || scope === 'deep') {
    if (!audit.raw_data || Object.keys(audit.raw_data).length === 0) {
      return { error: 'audit has no resource data to analyze', status: 400 }
    }
    // Cost/usage are merged back in here even though they're stored in
    // their own DB columns, so the full-subscription analysis doesn't lose
    // visibility into spend and utilization data.
    const costUsage = await findAuditCostUsageRaw(auditId)
    const previous = await findPreviousAuditCostUsageRaw(auditId)
    const precomputedSignals = buildPrecomputedSignals({
      costRows: costUsage?.cost?.actual_cost_rows,
      usageMetrics: costUsage?.usage?.metrics,
      inventory: (audit.raw_data as Record<string, unknown>)?.inventory as InventoryDataRaw | undefined,
      previousCostRows: previous?.cost?.actual_cost_rows,
      previousCostPeriod: previous?.cost ? { from: previous.cost.period_from, to: previous.cost.period_to } : undefined,
      previousUsageMetrics: previous?.usage?.metrics,
    })
    const fullData = {
      ...audit.raw_data,
      ...(costUsage?.cost ? { cost: costUsage.cost } : {}),
      ...(costUsage?.usage ? { usage: costUsage.usage } : {}),
      ...(precomputedSignals ? { precomputed_signals: precomputedSignals } : {}),
    }
    let instruction = `Analyze this Azure subscription. Find all problems, inefficiencies, misconfigurations, security gaps, and cost issues. Look across all resource types together — cross-resource patterns matter (e.g. a database in one region used by an app in another).\n\n${DEEP_RESEARCH_DIRECTIVE}\n\n${SEVERITY_RUBRIC}`
    if (precomputedSignals) instruction += `\n\n${PRECOMPUTED_SIGNALS_NOTE}`
    return { data: fullData, instruction }
  }

  // cost/usage live in their own DB columns, not raw_data — see
  // findAuditCostRaw/findAuditUsageRaw's doc comments for why they're kept
  // separate. "usage:<type>" analyzes one resource type's utilization only
  // (e.g. "usage:storage"), matching the same per-type split used by the
  // Resource Utilization dropdown and the scope selectors in the UI.
  let resourceData: unknown
  let instruction: string
  let precomputedSignals: Record<string, unknown> | undefined
  if (scope === 'cost') {
    const cost = (await findAuditCostRaw(auditId))?.cost
    resourceData = cost
    instruction = 'Analyze the Cost Management data for this Azure subscription as a senior DevOps engineer would. Find cost waste, unexpected spend spikes, and opportunities to reduce spend.'
    const previous = await findPreviousAuditCostUsageRaw(auditId)
    precomputedSignals = buildPrecomputedSignals({
      costRows: cost?.actual_cost_rows,
      inventory: (audit.raw_data as Record<string, unknown>)?.inventory as InventoryDataRaw | undefined,
      previousCostRows: previous?.cost?.actual_cost_rows,
      previousCostPeriod: previous?.cost ? { from: previous.cost.period_from, to: previous.cost.period_to } : undefined,
    })
  } else if (scope.startsWith('usage:')) {
    const usageType = scope.slice('usage:'.length)
    const usageRaw = await findAuditUsageRaw(auditId)
    const allMetrics = usageRaw?.metrics || []
    const groups = buildUsageGroups(allMetrics, usageType)
    resourceData = groups.length > 0 ? { type: usageType, groups } : undefined
    instruction = `Analyze the utilization metrics for "${usageType}" resources in this Azure subscription as a senior DevOps engineer would. Find idle, over-provisioned, or under-utilized resources.`
    const previous = await findPreviousAuditCostUsageRaw(auditId)
    const scopedMetrics = allMetrics.filter(m => resourceTypeSlug(m.resource_id) === usageType)
    const previousScopedMetrics = (previous?.usage?.metrics || []).filter(m => resourceTypeSlug(m.resource_id) === usageType)
    precomputedSignals = buildPrecomputedSignals({
      usageMetrics: scopedMetrics,
      previousUsageMetrics: previousScopedMetrics.length > 0 ? previousScopedMetrics : undefined,
    })
  } else if (scope === 'usage') {
    const usage = (await findAuditCostUsageRaw(auditId))?.usage // legacy combined scope, kept for old cache entries only
    resourceData = usage
    instruction = 'Analyze the Azure Monitor usage data for this subscription as a senior DevOps engineer would. Find idle, over-provisioned, or under-utilized resources.'
    precomputedSignals = buildPrecomputedSignals({ usageMetrics: usage?.metrics })
  } else {
    resourceData = (audit.raw_data as Record<string, unknown> | undefined)?.[scope]
    instruction = `Analyze the "${scope}" resources in this Azure subscription as a senior DevOps engineer would. Find all problems, inefficiencies, misconfigurations, security gaps, and cost issues specific to this resource type.`
    // Best-practice checklist (spec 10, Phase 2) — only applies to a single
    // resource-type scope, since it's keyed by that type; folded into
    // Stage 1/2 of the deep-research playbook below.
    const checklist = checklistForType(scope)
    if (checklist) instruction += `\n\n${checklist}`
  }
  if (resourceData === undefined || resourceData === null) {
    return { error: `no data for resource type "${scope}" in this audit`, status: 400 }
  }
  if (precomputedSignals) instruction += `\n\n${PRECOMPUTED_SIGNALS_NOTE}`
  const data = { [scope]: resourceData, ...(precomputedSignals ? { precomputed_signals: precomputedSignals } : {}) }
  return { data, instruction: `${instruction}\n\n${DEEP_RESEARCH_DIRECTIVE}\n\n${SEVERITY_RUBRIC}` }
}

// Persists a finished analysis for a scope — merges it into the cached
// claude_analysis store and runs the findings lifecycle. Shared by the
// synchronous LLM path (runAnalysis) and the MCP server's save_analysis
// tool (spec 8), so both write results identically.
export async function saveAnalysisResult(auditId: string, scope: string, analysis: ClaudeAnalysis): Promise<void> {
  const existing = normalizeStore(await findAnalysisById(auditId))
  const merged: ClaudeAnalysisStore = scope === 'all'
    ? { ...existing, all: analysis }
    : { ...existing, by_resource: { ...(existing.by_resource || {}), [scope]: analysis } }
  await updateClaudeAnalysis(auditId, merged)
  await saveFindings(auditId, analysis.findings, scope)
}

/**
 * Analyzes one audit with an LLM called directly from this request. By
 * default (no resourceSlug) this only scopes to a single resource type —
 * cheap and fast. Pass resourceSlug omitted and scope "all" explicitly from
 * the caller to analyze the entire audit (all resource types) in one
 * request — slower and more expensive, so the frontend gates that behind a
 * confirmation dialog.
 */
export async function runAnalysis(
  auditId: string,
  resourceSlug?: string,
  provider: LLMProvider = DEFAULT_PROVIDER,
  model: string = DEFAULT_MODEL
): Promise<{ analysis?: ClaudeAnalysis; error?: string; status: number; cached?: boolean }> {
  const scope = resourceSlug || 'all'
  const existing = normalizeStore(await findAnalysisById(auditId))
  const cached = scope === 'all' ? existing.all : existing.by_resource?.[scope]
  if (cached) return { analysis: cached, status: 200, cached: true }

  const scoped = await getScopedAuditData(auditId, scope)
  if ('error' in scoped) return scoped

  const result = await analyzeWithLLM(scoped.data, scoped.instruction, provider, model)
  if ('error' in result) return result

  await saveAnalysisResult(auditId, scope, result.analysis)
  return { analysis: result.analysis, status: 200, cached: false }
}

// Narrows chat context to one scope (a resource type, "cost", "usage:<type>",
// or undefined/"all" for everything) — same scope values the Analyze panel
// uses, so switching the Chat dropdown and the Analyze dropdown feel like
// the same concept. Narrowing keeps requests smaller and answers focused
// when the user only cares about one part of the audit.
async function buildChatContextData(auditId: string, audit: { raw_data: Record<string, unknown> }, scope?: string): Promise<unknown> {
  if (!scope || scope === 'all') {
    const costUsage = await findAuditCostUsageRaw(auditId)
    return {
      ...audit.raw_data,
      ...(costUsage?.cost ? { cost: costUsage.cost } : {}),
      ...(costUsage?.usage ? { usage: costUsage.usage } : {}),
    }
  }
  if (scope === 'cost') {
    return { cost: (await findAuditCostRaw(auditId))?.cost }
  }
  if (scope.startsWith('usage:')) {
    const usageType = scope.slice('usage:'.length)
    const usageRaw = await findAuditUsageRaw(auditId)
    return { usage: { type: usageType, groups: buildUsageGroups(usageRaw?.metrics || [], usageType) } }
  }
  if (scope in audit.raw_data) {
    return { [scope]: audit.raw_data[scope] }
  }
  // Unknown scope — fail open to full context rather than erroring the chat.
  const costUsage = await findAuditCostUsageRaw(auditId)
  return {
    ...audit.raw_data,
    ...(costUsage?.cost ? { cost: costUsage.cost } : {}),
    ...(costUsage?.usage ? { usage: costUsage.usage } : {}),
  }
}

export async function runChat(
  auditId: string,
  question: string,
  history: ChatMessage[],
  provider: LLMProvider = DEFAULT_PROVIDER,
  model: string = DEFAULT_MODEL,
  scope?: string
): Promise<{ reply?: string; error?: string; status: number; usedProvider?: LLMProvider; usedModel?: string; usedFallback?: boolean }> {
  const audit = await findAuditById(auditId)
  if (!audit) return { error: 'audit not found', status: 404 }

  let findings: Finding[] = []
  try { findings = await findFindingsByAudit(auditId) } catch { /* findings are optional context */ }

  const scopedData = await buildChatContextData(auditId, audit, scope)

  const context = `You are the assistant inside the BTG DevOps dashboard. You answer questions about ONE specific Azure audit, scoped to the data below. Be concrete and reference specific resources by name. If asked something outside this audit's data, say you only have access to this audit.

Audit metadata: id=${audit.id}, created_at=${audit.created_at}, subscription=${audit.subscription_name || audit.subscription_id}, status=${audit.status}

Resource data:
${JSON.stringify(scopedData)}

${findings.length > 0 ? `Existing analysis findings:\n${JSON.stringify(findings)}` : ''}`

  const messages: LLMMessage[] = [
    { role: 'user', content: context },
    { role: 'assistant', content: 'Understood. I have the audit data loaded and I am ready to answer questions about it.' },
    ...history.slice(-10).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: question },
  ]

  let result
  try {
    result = await callLLMWithFallback({ provider, model }, messages, 4000)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'chat call failed', status: 502 }
  }
  if (!result.text) return { error: 'empty response from model', status: 502 }

  return {
    reply: result.text,
    status: 200,
    usedProvider: result.provider,
    usedModel: result.model,
    usedFallback: result.usedFallback,
  }
}
