import { getDB } from './core';

// ── Dashboard aggregates ───────────────────────────────────────────────────────

export async function getDashboardStats(auditId?: string) {
  const db = await getDB();
  const filterClause = auditId ? 'WHERE audit_id = $1' : '';
  const params = auditId ? [auditId] : [];

  const [byService, bySeverity, byCategory, recentAudits] = await Promise.all([
    db.query(`SELECT service, COUNT(*)::int as count FROM findings ${filterClause} GROUP BY service ORDER BY count DESC`, params),
    db.query(`SELECT severity, COUNT(*)::int as count FROM findings ${filterClause} GROUP BY severity`, params),
    db.query(`SELECT category, COUNT(*)::int as count FROM findings ${filterClause} GROUP BY category ORDER BY count DESC`, params),
    db.query(`SELECT id, name, status, started_at, total_findings, critical_count, warning_count, info_count
              FROM audits ORDER BY started_at DESC LIMIT 10`),
  ]);

  return {
    byService: byService.rows,
    bySeverity: bySeverity.rows,
    byCategory: byCategory.rows,
    recentAudits: recentAudits.rows,
  };
}
