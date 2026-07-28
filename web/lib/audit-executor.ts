import {
  getSubscription,
  createAudit,
  insertFindings,
  updateAuditCounts,
  updateAuditStep,
  failAudit,
  getDB,
} from '@/lib/db';
import { runAllCommands, ALL_COMMANDS, Command, getPPCredentials } from '@/lib/btg-runner';
import { sendAuditSummaryEmail, sendScheduleFailureEmail, getNotificationRecipients } from '@/lib/mailer';

export class AuditExecutorError extends Error {}

/** Resolves credentials for a subscription, then runs and persists an audit.
 * Shared by the manual "Run Audit" API route and the automatic scheduler, so
 * both go through the exact same execution path. */
export async function executeAudit(
  subscriptionId: string,
  commands?: Command[],
  name?: string
): Promise<{ auditId: string }> {
  const db = getDB();
  const resolvedSubId: string = subscriptionId ||
    (db.prepare("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id || '';

  const sub = getSubscription(resolvedSubId);
  if (!sub) {
    throw new AuditExecutorError('No active subscription found. Add one in Settings.');
  }

  const row = db.prepare('SELECT client_secret FROM subscriptions WHERE id = ?').get(resolvedSubId) as { client_secret: string } | null;
  const credentials = {
    tenantId: sub.tenant_id || process.env.AZURE_TENANT_ID || '',
    clientId: sub.client_id || process.env.AZURE_CLIENT_ID || '',
    clientSecret: row?.client_secret || process.env.AZURE_CLIENT_SECRET || '',
    subscriptionId: sub.subscription_id || process.env.AZURE_SUBSCRIPTION_ID || '',
  };

  if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
    throw new AuditExecutorError('Missing Azure credentials. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in .env.local');
  }

  const cmdsToRun: Command[] = commands ?? [...ALL_COMMANDS];
  const auditName = name || `Audit ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  const audit = createAudit(resolvedSubId, auditName, cmdsToRun);

  const ppCredentials = getPPCredentials(credentials);

  runAllCommands(cmdsToRun, credentials, ppCredentials, (cmd, _count) => {
    const done = cmdsToRun.indexOf(cmd) + 1;
    updateAuditStep(audit.id, cmd, done);
  })
    .then(async ({ findings, ran, resourcesScanned }) => {
      if (findings.length > 0) insertFindings(audit.id, findings);
      const crit = findings.filter(f => f.severity === 'Critical').length;
      const warn = findings.filter(f => f.severity === 'Warning').length;
      const info = findings.filter(f => f.severity === 'Info').length;
      updateAuditCounts(audit.id, crit, warn, info, ran, resourcesScanned);

      const recipients = getNotificationRecipients();
      if (recipients) {
        try {
          await sendAuditSummaryEmail(recipients, auditName, { total: crit + warn + info, critical: crit, warning: warn, info }, audit.id);
        } catch (e) {
          console.warn('[audit-executor] email notification failed:', e);
        }
      }
    })
    .catch(async e => {
      failAudit(audit.id, String(e));
      const recipients = getNotificationRecipients();
      if (recipients) {
        try {
          await sendScheduleFailureEmail(recipients, auditName, String(e));
        } catch (emailErr) {
          console.warn('[audit-executor] failure email failed:', emailErr);
        }
      }
    });

  return { auditId: audit.id };
}
