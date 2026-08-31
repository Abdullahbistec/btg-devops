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
    const db = await getDB();

    // Latest completed audit if no ID specified — must actually match the requested scope,
    // otherwise viewing scope=pp after an Azure-only scan resolves to an audit with zero PP data.
    let resolvedAuditId = auditId;
    if (!resolvedAuditId) {
      const recentRes = await db.query(
        `SELECT id, commands_run FROM audits WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 25`
      );
      const recent = recentRes.rows as { id: string; commands_run: string }[];
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

    // resolvedAuditId is the one piece of this WHERE fragment that can come
    // from a caller (the audit_id query param) — bound as $1 rather than
    // string-interpolated. PP_LIST/HETZNER_LIST below are fixed, escaped
    // constants derived from btg-runner.ts's own service-label sets, not
    // caller input, so embedding them directly is unchanged from before.
    const auditClause = resolvedAuditId ? `WHERE f.audit_id = $1` : 'WHERE 1=1';
    const auditParams = resolvedAuditId ? [resolvedAuditId] : [];
    const scopeClause = buildScopeFilter(scope);
    const where = `${auditClause} ${scopeClause}`;

    const kpiRes = await db.query(`
      SELECT
        COUNT(*)::int as total,
        SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END)::int as critical,
        SUM(CASE WHEN severity = 'Warning'  THEN 1 ELSE 0 END)::int as warning,
        SUM(CASE WHEN severity = 'Info'     THEN 1 ELSE 0 END)::int as info
      FROM findings f ${where}
    `, auditParams);
    const kpi = kpiRes.rows[0] as { total: number; critical: number; warning: number; info: number };

    const byServiceRes = await db.query(`
      SELECT service, COUNT(*)::int as count
      FROM findings f ${where}
      GROUP BY service ORDER BY count DESC LIMIT 12
    `, auditParams);
    const byService = byServiceRes.rows as { service: string; count: number }[];

    const bySeverityRes = await db.query(`
      SELECT severity, COUNT(*)::int as count
      FROM findings f ${where}
      GROUP BY severity
    `, auditParams);
    const bySeverity = bySeverityRes.rows as { severity: string; count: number }[];

    const byCategoryRes = await db.query(`
      SELECT category, COUNT(*)::int as count
      FROM findings f ${where}
      GROUP BY category ORDER BY count DESC LIMIT 8
    `, auditParams);
    const byCategory = byCategoryRes.rows as { category: string; count: number }[];

    const trendRawRes = await db.query(`
      SELECT id, name, started_at, total_findings, critical_count, warning_count, info_count
      FROM audits
      WHERE status = 'completed'
      ORDER BY started_at DESC LIMIT 20
    `);
    const trendRaw = trendRawRes.rows as {
      id: string; name: string; started_at: string;
      total_findings: number; critical_count: number;
      warning_count: number; info_count: number;
    }[];

    // Audits don't run on a fixed calendar cadence, so there's no "this
    // audit, one year ago" the way a dated metric would have. The closest
    // equivalent comparison this data supports is by POSITION: the most
    // recent 10 runs against the 10 runs before those, paired up 1st-to-1st,
    // 2nd-to-2nd, etc. — trendRaw is newest-first, so reverse to chronological
    // before slicing the two windows out.
    const chronological = [...trendRaw].reverse();
    const current  = chronological.slice(-10);
    const previous = chronological.slice(-20, -10);

    const trend = current.map((row, i) => ({
      ...row,
      prev_total_findings: previous[i]?.total_findings ?? null,
    }));

    const avgFindings = (rows: { total_findings: number }[]) =>
      rows.length ? rows.reduce((sum, r) => sum + r.total_findings, 0) / rows.length : null;
    const avgCurrent  = avgFindings(current);
    const avgPrevious = avgFindings(previous);
    // null (not 0) when there's no previous window yet, or its average is
    // exactly 0 — "% change from zero" has no sensible value, and the
    // dashboard card hides the badge entirely rather than show a fake one.
    const trendChangePct = (avgCurrent !== null && avgPrevious)
      ? Math.round(((avgCurrent - avgPrevious) / avgPrevious) * 1000) / 10
      : null;

    const subsRes = await db.query('SELECT id, name, is_active FROM subscriptions');
    const subs = subsRes.rows as { id: string; name: string; is_active: number }[];

    const recentAudits = (await listAudits()).slice(0, 8);

    // Resources scanned — sum from the resolved audit; sum across every
    // completed audit only for the unscoped "All Providers" view with no
    // audit_id given. A specific scope (azure/pp/hetzner) that found no
    // matching audit must report 0, not silently fall back to a sum across
    // every other provider's audits too — that produced a nonsensical
    // "31362 resources scanned" on a Hetzner view with zero Hetzner audits.
    let resourcesRow: { resources_scanned: number } | undefined;
    if (resolvedAuditId) {
      const r = await db.query(`SELECT resources_scanned FROM audits WHERE id = $1`, [resolvedAuditId]);
      resourcesRow = r.rows[0];
    } else if (!scope) {
      const r = await db.query(`SELECT SUM(resources_scanned)::int as resources_scanned FROM audits WHERE status = 'completed'`);
      resourcesRow = r.rows[0];
    }
    const resourcesScanned = resourcesRow?.resources_scanned ?? 0;

    // PP readiness: at least one PP finding exists (any audit, any time)
    const ppCountRes = await db.query(`SELECT COUNT(*)::int as c FROM findings WHERE service IN (${PP_LIST})`);
    const ppCount = ppCountRes.rows[0] as { c: number };
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
      trend,
      trendChangePct,
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
