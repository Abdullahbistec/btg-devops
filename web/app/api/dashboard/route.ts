import { NextRequest, NextResponse } from 'next/server';
import { getDB, listAudits } from '@/lib/db';
import { PP_SERVICE_LABELS, HETZNER_SERVICE_LABELS, PP_COMMANDS, AZURE_COMMANDS, HETZNER_COMMANDS } from '@/lib/btg-runner';

// SQL IN-lists per provider — used to scope queries. "azure" is everything
// NOT in PP or Hetzner's label sets, rather than its own explicit list,
// since Azure has no fixed service-label set (new Azure analyzers add new
// labels here for free); PP and Hetzner both do, so they're excluded by name.
const PP_LIST      = [...PP_SERVICE_LABELS].map(s => `'${s.replace(/'/g, "''")}'`).join(',');
const HETZNER_LIST = [...HETZNER_SERVICE_LABELS].map(s => `'${s.replace(/'/g, "''")}'`).join(',');

function buildScopeFilter(scope: string, tableAlias = 'f'): string {
  if (scope === 'pp')      return `AND ${tableAlias}.service IN (${PP_LIST})`;
  if (scope === 'hetzner') return `AND ${tableAlias}.service IN (${HETZNER_LIST})`;
  if (scope === 'azure')   return `AND ${tableAlias}.service NOT IN (${PP_LIST}) AND ${tableAlias}.service NOT IN (${HETZNER_LIST})`;
  return '';
}

export async function GET(req: NextRequest) {
  try {
    const auditId = req.nextUrl.searchParams.get('audit_id') ?? undefined;
    const scope   = req.nextUrl.searchParams.get('scope') ?? '';
    const db = getDB();

    // Latest completed audit if no ID specified — must actually match the requested scope,
    // otherwise viewing scope=pp after an Azure-only scan resolves to an audit with zero PP data.
    let resolvedAuditId = auditId;
    if (!resolvedAuditId) {
      const recent = db.prepare(
        `SELECT id, commands_run FROM audits WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 25`
      ).all() as { id: string; commands_run: string }[];
      const wanted = scope === 'pp' ? PP_COMMANDS : scope === 'azure' ? AZURE_COMMANDS : scope === 'hetzner' ? HETZNER_COMMANDS : null;
      if (!wanted) {
        resolvedAuditId = recent[0]?.id;
      } else {
        for (const audit of recent) {
          let commands: string[] = [];
          try { commands = JSON.parse(audit.commands_run); } catch { /* ignore */ }
          if (commands.some(c => (wanted as readonly string[]).includes(c))) { resolvedAuditId = audit.id; break; }
        }
      }
    }

    const auditClause = resolvedAuditId
      ? `WHERE f.audit_id = '${resolvedAuditId.replace(/'/g, "''")}'`
      : 'WHERE 1=1';
    const scopeClause = buildScopeFilter(scope);
    const where = `${auditClause} ${scopeClause}`;

    const kpi = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity = 'Warning'  THEN 1 ELSE 0 END) as warning,
        SUM(CASE WHEN severity = 'Info'     THEN 1 ELSE 0 END) as info
      FROM findings f ${where}
    `).get() as { total: number; critical: number; warning: number; info: number };

    const byService = db.prepare(`
      SELECT service, COUNT(*) as count
      FROM findings f ${where}
      GROUP BY service ORDER BY count DESC LIMIT 12
    `).all() as { service: string; count: number }[];

    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM findings f ${where}
      GROUP BY severity
    `).all() as { severity: string; count: number }[];

    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM findings f ${where}
      GROUP BY category ORDER BY count DESC LIMIT 8
    `).all() as { category: string; count: number }[];

    const trend = db.prepare(`
      SELECT id, name, started_at, total_findings, critical_count, warning_count, info_count
      FROM audits
      WHERE status = 'completed'
      ORDER BY started_at DESC LIMIT 10
    `).all() as {
      id: string; name: string; started_at: string;
      total_findings: number; critical_count: number;
      warning_count: number; info_count: number;
    }[];

    const subs = db.prepare(
      'SELECT id, name, is_active FROM subscriptions'
    ).all() as { id: string; name: string; is_active: number }[];

    const recentAudits = listAudits().slice(0, 8);

    // Resources scanned — sum from the resolved audit; sum across every
    // completed audit only for the unscoped "All Providers" view with no
    // audit_id given. A specific scope (azure/pp/hetzner) that found no
    // matching audit must report 0, not silently fall back to a sum across
    // every other provider's audits too — that produced a nonsensical
    // "31362 resources scanned" on a Hetzner view with zero Hetzner audits.
    const resourcesRow = resolvedAuditId
      ? db.prepare(`SELECT resources_scanned FROM audits WHERE id = ?`).get(resolvedAuditId) as { resources_scanned: number } | undefined
      : !scope
      ? db.prepare(`SELECT SUM(resources_scanned) as resources_scanned FROM audits WHERE status = 'completed'`).get() as { resources_scanned: number } | undefined
      : undefined;
    const resourcesScanned = resourcesRow?.resources_scanned ?? 0;

    // PP readiness: at least one PP finding exists (any audit, any time)
    const ppCount = db.prepare(
      `SELECT COUNT(*) as c FROM findings WHERE service IN (${PP_LIST})`
    ).get() as { c: number };
    const ppReady = (ppCount?.c ?? 0) > 0;

    // PP credentials configured at the web layer?
    const ppCredsConfigured = !!(
      process.env.BTG_PP_CLIENT_ID ||
      process.env.AZURE_CLIENT_ID
    );

    return NextResponse.json({
      kpi,
      byService,
      bySeverity,
      byCategory,
      trend: (trend as typeof trend).reverse(),
      subscriptions: subs,
      recentAudits,
      resolvedAuditId,
      ppReady,
      ppCredsConfigured,
      resourcesScanned,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
