import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { PP_SERVICE_LABELS, PP_COMMANDS, AZURE_COMMANDS } from '@/lib/btg-runner';
import type { Finding } from '@/lib/db';

const PP_LIST = [...PP_SERVICE_LABELS].map(s => `'${s.replace(/'/g, "''")}'`).join(',');

/** Most recent completed audit whose commands_run overlaps the given scope. */
function resolveLatestAuditForScope(scope: string): string | undefined {
  const db = getDB();
  const recent = db.prepare(
    `SELECT id, commands_run FROM audits WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 25`
  ).all() as { id: string; commands_run: string }[];

  const wanted = scope === 'pp' ? PP_COMMANDS : scope === 'azure' ? AZURE_COMMANDS : null;
  if (!wanted) return recent[0]?.id;

  for (const audit of recent) {
    let commands: string[] = [];
    try { commands = JSON.parse(audit.commands_run); } catch { /* ignore */ }
    if (commands.some(c => (wanted as readonly string[]).includes(c))) return audit.id;
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  try {
    const severity = req.nextUrl.searchParams.get('severity') ?? '';
    const scope    = req.nextUrl.searchParams.get('scope') ?? '';
    const remediationStatus = req.nextUrl.searchParams.get('remediation_status') ?? '';
    const db = getDB();

    // Default to the latest relevant audit — never show findings pooled across every audit ever run.
    const auditId = req.nextUrl.searchParams.get('audit_id') || resolveLatestAuditForScope(scope) || '';

    const clauses: string[] = [];
    if (auditId)  clauses.push(`audit_id = '${auditId.replace(/'/g, "''")}'`);
    if (severity) clauses.push(`severity = '${severity.replace(/'/g, "''")}'`);
    if (remediationStatus) clauses.push(`remediation_status = '${remediationStatus.replace(/'/g, "''")}'`);
    if (scope === 'pp')    clauses.push(`service IN (${PP_LIST})`);
    if (scope === 'azure') clauses.push(`service NOT IN (${PP_LIST})`);

    // When scoped to a specific audit, return everything for it — a severity-sorted
    // cap here previously let one high-volume service (e.g. many Critical "Orphaned
    // App" findings) crowd every other service out of a 200-row window entirely.
    const limit = auditId ? 5000 : 200;

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM findings ${where} ORDER BY severity, service LIMIT ${limit}`
    ).all() as unknown as Finding[];

    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
