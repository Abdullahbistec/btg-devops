import { NextRequest, NextResponse } from 'next/server';
import { getDB, getUserByEmail } from '@/lib/db';

async function isAdmin(req: NextRequest): Promise<boolean> {
  const identity = req.cookies.get('btg_identity')?.value ?? '';
  if (!identity) return false;
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (identity === adminEmail) return true;
  try {
    const user = await getUserByEmail(identity);
    return user?.role === 'admin' && user?.status === 'active';
  } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const db = await getDB();

  const usersRes = await db.query(`
    SELECT
      COUNT(*)::int as total,
      SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END)::int as pending,
      SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END)::int as active,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END)::int as rejected,
      SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END)::int as inactive
    FROM users
  `);
  const users = usersRes.rows[0] as { total: number; pending: number; active: number; rejected: number; inactive: number };

  const auditsRes = await db.query(`
    SELECT
      COUNT(*)::int as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed,
      SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)::int as failed,
      SUM(CASE WHEN status = 'running'   THEN 1 ELSE 0 END)::int as running
    FROM audits
  `);
  const audits = auditsRes.rows[0] as { total: number; completed: number; failed: number; running: number };

  const findingsRes = await db.query(`
    SELECT
      COUNT(*)::int as total,
      SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END)::int as critical,
      SUM(CASE WHEN severity = 'Warning'  THEN 1 ELSE 0 END)::int as warning,
      SUM(CASE WHEN severity = 'Info'     THEN 1 ELSE 0 END)::int as info
    FROM findings
  `);
  const findings = findingsRes.rows[0] as { total: number; critical: number; warning: number; info: number };

  const subCountRes = await db.query('SELECT COUNT(*)::int as c FROM subscriptions');
  const subCount = (subCountRes.rows[0] as { c: number }).c;

  const latestAuditRes = await db.query(
    `SELECT name, completed_at, total_findings, critical_count, resources_scanned FROM audits WHERE status='completed' ORDER BY completed_at DESC LIMIT 1`
  );
  const latestAudit = latestAuditRes.rows[0] as { name: string; completed_at: string; total_findings: number; critical_count: number; resources_scanned: number } | undefined;

  const recentAuditsRes = await db.query(
    `SELECT id, name, status, started_at, completed_at, total_findings, critical_count, warning_count, info_count, resources_scanned FROM audits ORDER BY started_at DESC LIMIT 20`
  );
  const recentAudits = recentAuditsRes.rows as {
    id: string; name: string; status: string; started_at: string; completed_at: string;
    total_findings: number; critical_count: number; warning_count: number; info_count: number; resources_scanned: number;
  }[];

  const envChecks = {
    smtp: !!(process.env.SMTP_PASS && process.env.SMTP_PASS !== 'your-email-password-here'),
    azureCreds: !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET),
    adminEmail: !!process.env.ADMIN_EMAIL,
    sessionSecret: !!(process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'btg-devops-default-secret'),
    ppCreds: !!(process.env.BTG_PP_CLIENT_ID || process.env.BTG_PP_CLIENT_SECRET),
  };

  return NextResponse.json({ users, audits, findings, subscriptions: subCount, latestAudit, recentAudits, envChecks });
}
