import { NextRequest, NextResponse } from 'next/server';
import { getDB, getUserByEmail } from '@/lib/db';

function isAdmin(req: NextRequest): boolean {
  const identity = req.cookies.get('btg_identity')?.value ?? '';
  if (!identity) return false;
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (identity === adminEmail) return true;
  try {
    const user = getUserByEmail(identity);
    return user?.role === 'admin' && user?.status === 'active';
  } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const db = getDB();

  const users = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) as inactive
    FROM users
  `).get() as { total: number; pending: number; active: number; rejected: number; inactive: number };

  const audits = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'running'   THEN 1 ELSE 0 END) as running
    FROM audits
  `).get() as { total: number; completed: number; failed: number; running: number };

  const findings = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity = 'Warning'  THEN 1 ELSE 0 END) as warning,
      SUM(CASE WHEN severity = 'Info'     THEN 1 ELSE 0 END) as info
    FROM findings
  `).get() as { total: number; critical: number; warning: number; info: number };

  const subCount = (db.prepare('SELECT COUNT(*) as c FROM subscriptions').get() as { c: number }).c;

  const latestAudit = db.prepare(
    `SELECT name, completed_at, total_findings, critical_count, resources_scanned FROM audits WHERE status='completed' ORDER BY completed_at DESC LIMIT 1`
  ).get() as { name: string; completed_at: string; total_findings: number; critical_count: number; resources_scanned: number } | undefined;

  const recentAudits = db.prepare(
    `SELECT id, name, status, started_at, completed_at, total_findings, critical_count, warning_count, info_count, resources_scanned FROM audits ORDER BY started_at DESC LIMIT 20`
  ).all() as {
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
