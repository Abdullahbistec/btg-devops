import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  listPendingAnalysisRequests,
  findPendingAnalysisRequest,
  markAnalysisRequestDone,
  markAnalysisRequestFailed,
  hasNoPendingForAudit,
  hasNewlyUnblockedCostUsage,
} from '../models/analysisRequests'
import { findSubscriptionFindingHistory } from '../models/findings'
import { getScopedAuditData, saveAnalysisResult, type ClaudeAnalysis } from '../utils/claude'
import { buildAuditSummaryEmail } from '../utils/auditSummaryEmail'
import { sendMail, resolveNotificationRecipients } from '../utils/mailer'
import { triggerAnalyzerRoutine } from '../utils/analyzerRoutine'
import { resolveCachedAnalysisRequests, listChangedScopes, getCachedScopeAnalysis } from '../utils/analysisCache'

// Thin MCP wrappers over the dashboard's existing model/util functions
// (spec 8) — no business logic lives here. The scheduled Claude Code agent
// is the thing that actually reasons about the data; these three tools are
// just its window into the dashboard's Postgres data.

const findingSchema = z.object({
  // Must follow the severity rubric returned in get_audit_data's `instruction`
  // text — do not default to Critical for anything security-related; pick
  // the lower severity when unsure.
  severity: z.enum(['Critical', 'Warning', 'Info']).describe('Follow the severity rubric from get_audit_data\'s instruction exactly — Critical is reserved for actively exploitable/internet-exposed/bleeding-money-today issues, never assigned by category alone.'),
  category: z.string(),
  resource_type: z.string(),
  resource_name: z.string(),
  // The resourceGroup field from the resource's own data (cleaner.go attaches
  // it to every extracted item) — omit for scopes (cost/usage/all) where a
  // finding doesn't map to one resource group.
  resource_group: z.string().optional(),
  // Account-based resource types only (cosmosdb, storage, appserviceplan) —
  // resource_name is the account/plan, this is the specific database/
  // container/app. See findingsLayout.ts.
  child_resource_name: z.string().optional(),
  // Flat resource types only — every resource affected by the SAME issue,
  // when one finding covers a pattern across multiple resources.
  affected_resources: z.array(z.string()).optional(),
  cost_impact_usd: z.number().optional(),
  cost_impact_note: z.string().optional(),
  issue: z.string().describe('Plain-English statement of the problem, for a non-technical reader. Do NOT put raw field names/values here — that belongs in `evidence`.'),
  // Split from `issue` (spec: "curated problem + why it's a problem, with
  // evidence" UI) so the card can show the plain-English problem and the raw
  // proof as two visually distinct sections instead of one dense sentence.
  evidence: z.string().describe('The raw field/value proof from the audit data that justifies this finding (e.g. "publicNetworkAccess = \\"Enabled\\", ipRules = [] (empty)"). Must cite exact fields and values — do not report a finding you cannot point to specific evidence for. Required for every finding.'),
  // Legacy flat fix text — optional here because it's derived from
  // recommendation_steps below if the agent only supplies the array (the
  // preferred, structured field this UI actually renders).
  recommendation: z.string().optional(),
  recommendation_steps: z.array(z.string()).max(4).optional(),
  // Cost to FIX (separate from severity, which is cost of the PROBLEM) —
  // powers the "Quick wins" UI section. quick = one CLI command/portal
  // toggle; moderate = needs some planning/testing; complex = migration,
  // downtime, or code change. A Critical finding can still be "quick".
  fix_effort: z.enum(['quick', 'moderate', 'complex']).optional(),
  // 'chain' marks a deep-research headline finding (playbook Stage 3) — set
  // this when the finding is several individually low-severity facts
  // reasoned together into one real attack path. Use affected_resources for
  // every resource in the chain in order, and issue for the full hop-by-hop
  // narrative. Omit (or 'standard') for every ordinary finding.
  finding_type: z.enum(['chain', 'standard']).optional(),
})

export function registerTools(server: McpServer) {
  server.registerTool(
    'list_pending_requests',
    {
      description: 'List analysis requests waiting to be processed (status=pending), oldest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('Max rows to return'),
      },
    },
    async ({ limit }) => {
      // Resolve any cache_hit requests first (spec 14) — their findings get
      // carried forward from a prior audit with no agent time spent, so they
      // never show up in the list below for the agent to work on.
      await resolveCachedAnalysisRequests(limit)
      const rows = await listPendingAnalysisRequests(limit)
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
    }
  )

  server.registerTool(
    'get_audit_data',
    {
      description: 'Fetch the Azure resource data and analysis instruction for one audit + scope (a resource type, "cost", "usage:<type>", or "all"). Use this to get the data to reason over for a pending analysis request.',
      inputSchema: {
        auditId: z.string().describe('The audit UUID (analysis_requests.audit_id)'),
        scope: z.string().describe('The scope (analysis_requests.scope) — a resource type, "cost", "usage:<type>", or "all"'),
      },
    },
    async ({ auditId, scope }) => {
      const result = await getScopedAuditData(auditId, scope)
      if ('error' in result) {
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  server.registerTool(
    'list_changed_scopes',
    {
      description: 'For the "all"-scope parallel fan-out only (spec 13): lists every resource-type scope this audit collected data for, each marked whether its config changed since the last audit whose analysis of that scope completed. A scope with changed=false should be resolved via get_cached_scope_analysis instead of spawning a per-type agent for it — do not analyze it yourself.',
      inputSchema: {
        auditId: z.string().describe('The audit UUID'),
      },
    },
    async ({ auditId }) => {
      const rows = await listChangedScopes(auditId)
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
    }
  )

  server.registerTool(
    'get_cached_scope_analysis',
    {
      description: 'For the "all"-scope parallel fan-out only (spec 13): returns the already-saved analysis (summary + findings) for a scope list_changed_scopes reported as unchanged, from the most recent prior audit whose analysis of that scope completed. Use this INSTEAD OF spawning a per-type agent for that scope, and mark it carried_forward: true when passing it to synthesis. Returns null if no usable prior analysis exists — fall back to analyzing the scope normally in that case.',
      inputSchema: {
        auditId: z.string().describe('The audit UUID'),
        scope: z.string().describe('The resource-type scope to fetch the cached analysis for'),
      },
    },
    async ({ auditId, scope }) => {
      const analysis = await getCachedScopeAnalysis(auditId, scope)
      return { content: [{ type: 'text', text: JSON.stringify(analysis) }] }
    }
  )

  server.registerTool(
    'get_audit_history',
    {
      description: 'Get every finding (any status — open, dismissed, resolved) from past audits of the SAME subscription as auditId, oldest first, including the current audit. Use this in Stage 4 ("judge in context") of a deep-research request to check whether an issue has existed unresolved across multiple audits, or was already flagged and fixed/dismissed before — do not guess at history, call this instead.',
      inputSchema: {
        auditId: z.string().describe('The audit UUID to find subscription history for'),
        scope: z.string().optional().describe('Restrict to one scope (a resource type, "cost", "usage:<type>", or "all"). Omit to see history across every scope — needed for a "deep" request, since "deep" as a scope did not exist before spec 10 and prior audits will have their history under per-resource-type scopes instead.'),
        limit: z.number().int().min(1).max(1000).default(300).describe('Max rows to return'),
      },
    },
    async ({ auditId, scope, limit }) => {
      const rows = await findSubscriptionFindingHistory(auditId, scope, limit)
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
    }
  )

  server.registerTool(
    'save_analysis',
    {
      description: 'Save a finished analysis for one audit + scope: persists the summary/findings (with full findings lifecycle — dedup, age carry-forward, auto-resolve) and marks the matching pending request done.',
      inputSchema: {
        auditId: z.string().describe('The audit UUID'),
        scope: z.string().describe('The scope this analysis covers — must match the pending request\'s scope'),
        summary: z.string().describe('2-3 sentence overall assessment'),
        findings: z.array(findingSchema),
        model: z.string().default('claude-code-orchestrator').describe('Identifier for the model/agent that produced this analysis'),
        data_gaps: z.array(z.string()).optional().describe('Deep-research only (playbook Stage 5): data you needed but could not get from get_audit_data/get_audit_history, e.g. "could not verify Key Vault access — access policies not in audit data". Omit for ordinary (non-deep) analyses.'),
      },
    },
    async ({ auditId, scope, summary, findings, model, data_gaps }) => {
      const analysis: ClaudeAnalysis = {
        summary,
        // recommendation (legacy flat string, still read by exports/email/
        // chat context) is derived from recommendation_steps when the agent
        // only supplied the array — the field this UI actually renders.
        findings: findings.map(f => ({
          ...f,
          recommendation: f.recommendation_steps && f.recommendation_steps.length > 0
            ? f.recommendation_steps.join('. ')
            : f.recommendation || '',
        })),
        generated_at: new Date().toISOString(),
        model,
        data_gaps: data_gaps && data_gaps.length > 0 ? data_gaps : undefined,
      }
      try {
        await saveAnalysisResult(auditId, scope, analysis)
      } catch (e) {
        const message = e instanceof Error ? e.message : 'failed to save analysis'
        const pending = await findPendingAnalysisRequest(auditId, scope)
        if (pending) await markAnalysisRequestFailed(pending.id, message)
        await sendSummaryEmailIfAuditComplete(auditId)
        await wakeRoutineIfCostUsageUnblocked(auditId)
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
      }

      const pending = await findPendingAnalysisRequest(auditId, scope)
      if (pending) await markAnalysisRequestDone(pending.id)
      await sendSummaryEmailIfAuditComplete(auditId)
      await wakeRoutineIfCostUsageUnblocked(auditId)

      // findings/analysis were persisted either way (saveAnalysisResult above didn't throw), but
      // requestId is only non-null if a matching pending row for this exact auditId+scope existed
      // to mark done — surface that distinction explicitly instead of implying uniform success,
      // so a caller can't mistake "no matching request found" for "everything is fine."
      return { content: [{ type: 'text', text: JSON.stringify({
        saved: true,
        requestId: pending?.id ?? null,
        ...(pending ? {} : { warning: `analysis data was saved, but no pending request found for auditId=${auditId} scope=${scope} — nothing was marked done` }),
      }) }] }
    }
  )
}

// Cost/usage requests are held back by listPendingAnalysisRequests until
// every other scope for their audit resolves (see analysisRequests.ts) — so
// the moment a non-cost/usage save_analysis call is the LAST one blocking,
// the routine needs to be woken again immediately, or the now-unblocked
// cost/usage requests just sit there until its next cron tick. Checked
// after every save_analysis call (cheap no-op once an audit's cost/usage
// scopes are already unblocked or don't exist). Best-effort, same as the
// summary email: a failure here must never surface as an MCP tool error.
async function wakeRoutineIfCostUsageUnblocked(auditId: string): Promise<void> {
  try {
    if (await hasNewlyUnblockedCostUsage(auditId)) await triggerAnalyzerRoutine()
  } catch (e) {
    console.warn('[analyzer-routine] wake-on-unblock check failed:', e instanceof Error ? e.message : e)
  }
}

// One consolidated email per audit, not one per resource type — checked
// after every save_analysis call, fires only once (when the last pending
// request for this audit resolves). Best-effort: a notification failure
// must never surface as an MCP tool error to the analyzer.
async function sendSummaryEmailIfAuditComplete(auditId: string): Promise<void> {
  try {
    if (!(await hasNoPendingForAudit(auditId))) return
    const email = await buildAuditSummaryEmail(auditId)
    if (!email) return
    const recipients = await resolveNotificationRecipients()
    await sendMail(email.subject, email.html, recipients)
  } catch (e) {
    console.warn('[mailer] audit-complete summary email failed:', e instanceof Error ? e.message : e)
  }
}
