import { listFindings, getDashboardStats } from '@/lib/db';

const TOP_FINDINGS_LIMIT = 20;

/**
 * Builds the same findings-summary text block for both the synchronous
 * Gemini-backed assistant (/api/assistant) and the async MCP get_audit_data
 * tool — one place instead of two so the two paths can't drift on what
 * "context" means.
 */
export function buildAuditContext(auditId?: string, scope: string = 'all'): string {
  const stats = getDashboardStats(auditId);
  let findings = listFindings(auditId);
  if (scope !== 'all') {
    findings = findings.filter(f => f.service === scope);
  }

  const severityCounts = stats.bySeverity.map(s => `${s.severity}: ${s.count}`).join(', ');
  const serviceCounts = stats.byService.map(s => `${s.service}: ${s.count}`).join(', ');

  const severityOrder: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
  const top = [...findings]
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))
    .slice(0, TOP_FINDINGS_LIMIT)
    .map(f => `- [${f.severity}] ${f.service}/${f.resource || '(n/a)'}: ${f.description}`)
    .join('\n');

  return [
    scope !== 'all' ? `Scope: ${scope}` : '',
    `Total findings: ${findings.length}`,
    `By severity: ${severityCounts || 'none'}`,
    `By service: ${serviceCounts || 'none'}`,
    findings.length ? `Top findings:\n${top}` : 'No findings recorded for this audit.',
  ].filter(Boolean).join('\n\n');
}
