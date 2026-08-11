import { findAuditById } from '../models/audit'
import { findFindingsByAudit } from '../models/findings'
import { getAnalysisForScope } from './claude'
import { scopeLabel } from '../../lib/scopes'
import type { ExportableFinding, ExportMeta } from '../../lib/reportBuilders'

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://dashboard-eight-rho-42.vercel.app'
const SEVERITY_COLOR: Record<string, string> = { Critical: '#ef4444', Warning: '#f59e0b', Info: '#64748b' }

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function severityCountsHtml(findings: { severity: string }[]): string {
  const counts = { Critical: 0, Warning: 0, Info: 0 }
  for (const f of findings) counts[f.severity as keyof typeof counts]++
  return `
    <p>
      <span style="color:${SEVERITY_COLOR.Critical};font-weight:600;">${counts.Critical} Critical</span> &nbsp;
      <span style="color:${SEVERITY_COLOR.Warning};font-weight:600;">${counts.Warning} Warning</span> &nbsp;
      <span style="color:${SEVERITY_COLOR.Info};font-weight:600;">${counts.Info} Info</span>
    </p>
  `
}

// Builds the one consolidated "analysis complete" email for an audit — sent
// once, when every resource-type analysis_requests row for it has resolved
// (see the completion check in app/api/mcp/tools.ts's save_analysis tool),
// not once per resource type. A findings-per-scope email would mean up to
// ~14 emails per audit, which trains recipients to ignore them. Findings
// detail lives in the PDF/Excel attached by the caller, not this body.
export async function buildAuditSummaryEmail(auditId: string): Promise<{ subject: string; html: string } | null> {
  const audit = await findAuditById(auditId)
  if (!audit) return null

  const findings = (await findFindingsByAudit(auditId)).filter(f => f.status === 'open')
  const criticalCount = findings.filter(f => f.severity === 'Critical').length

  const subject = criticalCount > 0
    ? `[Critical] Azure audit analysis complete — ${criticalCount} critical finding(s)`
    : `Azure audit analysis complete — ${audit.subscription_name || audit.subscription_id}`

  const html = `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="margin-bottom:0.25rem;">Analysis complete: ${escapeHtml(audit.subscription_name || audit.subscription_id)}</h2>
      <p style="color:#64748b;margin-top:0;">Audit ${audit.id} · ${new Date(audit.created_at).toLocaleString()}</p>
      ${severityCountsHtml(findings)}
      <p><a href="${DASHBOARD_URL}/audits/${audit.id}" style="color:#7c3aed;">View full results →</a></p>
    </div>
  `

  return { subject, html }
}

export interface ScopeShareData {
  subject: string
  html: string
  findings: ExportableFinding[]
  reportMeta: ExportMeta
}

// Backs the manual "Share" action on the audit page — one scope, user-
// triggered on demand (vs. buildAuditSummaryEmail's whole-audit, system-
// triggered notification). Also returns the same findings/meta shape the
// Export button uses, so the caller can attach a matching PDF/Excel to the
// email instead of dumping the findings as inline text.
export async function buildScopeShareData(auditId: string, scope: string): Promise<ScopeShareData | null> {
  const audit = await findAuditById(auditId)
  if (!audit) return null

  const analysis = await getAnalysisForScope(auditId, scope)
  const rows = scope === 'all'
    ? (await findFindingsByAudit(auditId)).filter(f => f.status === 'open')
    : (await findFindingsByAudit(auditId, scope)).filter(f => f.status === 'open')

  const findings: ExportableFinding[] = rows.map(f => ({
    severity: f.severity,
    category: f.category || '',
    resource_type: f.resource_type,
    resource_name: f.resource_name,
    issue: f.issue,
    evidence: f.evidence || undefined,
    recommendation: f.recommendation,
  }))

  const label = scopeLabel(scope, [])
  const subject = `Shared: ${label} analysis — ${audit.subscription_name || audit.subscription_id}`

  const html = `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="margin-bottom:0.25rem;">${escapeHtml(label)} analysis: ${escapeHtml(audit.subscription_name || audit.subscription_id)}</h2>
      <p style="color:#64748b;margin-top:0;">Audit ${audit.id} · ${new Date(audit.created_at).toLocaleString()}</p>
      ${analysis?.summary ? `<p>${escapeHtml(analysis.summary)}</p>` : ''}
      ${severityCountsHtml(findings)}
      <p style="color:#64748b;">Full findings are attached as PDF and Excel reports.</p>
      <p><a href="${DASHBOARD_URL}/audits/${audit.id}" style="color:#7c3aed;">View in dashboard →</a></p>
    </div>
  `

  return {
    subject,
    html,
    findings,
    reportMeta: { auditId: audit.id, scopeLabel: label, summary: analysis?.summary || '', generatedAt: analysis?.generated_at || new Date().toISOString() },
  }
}
