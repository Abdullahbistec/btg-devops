import { NextResponse } from 'next/server';
import {
  getSubscription,
  createAudit,
  insertFindings,
  updateAuditCounts,
  failAudit,
  getDB,
} from '@/lib/db';
import { runAllCommands, ALL_COMMANDS, Command, getPPCredentials } from '@/lib/btg-runner';
import { sendAuditSummaryEmail } from '@/lib/mailer';
import { isAdminRequest } from '@/lib/auth';
import type { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    if (!isAdminRequest(req)) {
      return NextResponse.json({ error: 'Viewers cannot trigger scans. Contact an admin.' }, { status: 403 });
    }
    const body = await req.json();
    const { subscription_id, commands, name } = body as {
      subscription_id: string;
      commands?: Command[];
      name?: string;
    };

    // If no subscription_id given, fall back to the first active subscription
    const db2 = getDB();
    const resolvedSubId: string = subscription_id ||
      (db2.prepare("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id || '';

    const sub = getSubscription(resolvedSubId);
    if (!sub) {
      return NextResponse.json({ error: 'No active subscription found. Add one in Settings.' }, { status: 404 });
    }

    // Resolve credentials: prefer stored secret, fall back to env vars
    const row = db2.prepare('SELECT client_secret FROM subscriptions WHERE id = ?').get(resolvedSubId) as { client_secret: string } | null;
    const credentials = {
      tenantId: sub.tenant_id || process.env.AZURE_TENANT_ID || '',
      clientId: sub.client_id || process.env.AZURE_CLIENT_ID || '',
      clientSecret: row?.client_secret || process.env.AZURE_CLIENT_SECRET || '',
      subscriptionId: sub.subscription_id || process.env.AZURE_SUBSCRIPTION_ID || '',
    };

    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
      return NextResponse.json(
        { error: 'Missing Azure credentials. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in .env.local' },
        { status: 400 }
      );
    }

    const cmdsToRun: Command[] = commands ?? [...ALL_COMMANDS];
    const auditName = name || `Audit ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
    const audit = createAudit(resolvedSubId, auditName);

    const ppCredentials = getPPCredentials(credentials);

    // Run asynchronously — respond immediately with audit ID
    runAllCommands(cmdsToRun, credentials, ppCredentials)
      .then(async ({ findings, ran, resourcesScanned }) => {
        if (findings.length > 0) insertFindings(audit.id, findings);
        const crit = findings.filter(f => f.severity === 'Critical').length;
        const warn = findings.filter(f => f.severity === 'Warning').length;
        const info = findings.filter(f => f.severity === 'Info').length;
        updateAuditCounts(audit.id, crit, warn, info, ran, resourcesScanned);
        // Send summary email if admin email is configured
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
          try {
            await sendAuditSummaryEmail(adminEmail, auditName, { total: crit + warn + info, critical: crit, warning: warn, info });
          } catch (e) {
            console.warn('[audit/run] email notification failed:', e);
          }
        }
      })
      .catch(e => failAudit(audit.id, String(e)));

    return NextResponse.json({ audit_id: audit.id, status: 'running' }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
