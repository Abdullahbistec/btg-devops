import {
  getSubscription,
  createAudit,
  insertFindings,
  updateAuditCounts,
  updateAuditStep,
  failAudit,
  getDB,
} from '@/lib/db';
import { runAllCommands, ALL_COMMANDS, Command, getPPCredentials, isHetznerCommand } from '@/lib/btg-runner';
import { sendAuditSummaryEmail, sendScheduleFailureEmail, getNotificationRecipients } from '@/lib/mailer';
import { decryptSecret } from '@/lib/crypto';

export class AuditExecutorError extends Error {}

async function notifyFailure(auditName: string, message: string): Promise<void> {
  const recipients = getNotificationRecipients();
  if (!recipients) return;
  try {
    await sendScheduleFailureEmail(recipients, auditName, message);
  } catch (e) {
    console.warn('[audit-executor] failure email failed:', e);
  }
}

/** Resolves credentials for a subscription, then runs and persists an audit.
 * Shared by the manual "Run Audit" API route and the automatic scheduler, so
 * both go through the exact same execution path. */
export async function executeAudit(
  subscriptionId: string,
  commands?: Command[],
  name?: string
): Promise<{ auditId: string }> {
  const db = await getDB();
  const activeRes = await db.query("SELECT id FROM subscriptions WHERE is_active = true ORDER BY created_at LIMIT 1");
  const resolvedSubId: string = subscriptionId || (activeRes.rows[0] as { id: string } | undefined)?.id || '';

  const sub = await getSubscription(resolvedSubId);
  if (!sub) {
    throw new AuditExecutorError('No active subscription found. Add one in Settings.');
  }

  const secretRes = await db.query('SELECT client_secret FROM subscriptions WHERE id = $1', [resolvedSubId]);
  const row = secretRes.rows[0] as { client_secret: string } | undefined;
  const credentials = {
    tenantId: sub.tenant_id || process.env.AZURE_TENANT_ID || '',
    clientId: sub.client_id || process.env.AZURE_CLIENT_ID || '',
    clientSecret: (row?.client_secret ? decryptSecret(row.client_secret) : '') || process.env.AZURE_CLIENT_SECRET || '',
    subscriptionId: sub.subscription_id || process.env.AZURE_SUBSCRIPTION_ID || '',
  };

  const cmdsToRun: Command[] = commands ?? [...ALL_COMMANDS];
  const hcloudToken = process.env.HCLOUD_TOKEN || '';

  // Azure credentials are only required if the run actually includes a
  // non-Hetzner command — a Hetzner-only scan (single project API token,
  // no Azure-AD service principal involved) must not be blocked on them.
  const needsAzureCreds = cmdsToRun.some(c => !isHetznerCommand(c));
  if (needsAzureCreds && (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret)) {
    throw new AuditExecutorError('Missing Azure credentials. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in .env.local');
  }

  // The mirror of the guard above: a Hetzner-only run has no Azure command to
  // carry it, so with no token every command in it fails and the audit is
  // pointless. Deliberately NOT applied to a mixed run — ALL_COMMANDS
  // includes the Hetzner commands, so requiring the token whenever one is
  // present would block every default audit on an Azure-only deployment.
  // There, the Hetzner failures surface as a partial failure instead.
  const isHetznerOnly = cmdsToRun.length > 0 && cmdsToRun.every(c => isHetznerCommand(c));
  if (isHetznerOnly && !hcloudToken) {
    throw new AuditExecutorError('Missing Hetzner credentials. Set HCLOUD_TOKEN in .env.local');
  }

  const auditName = name || `Audit ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  const audit = await createAudit(resolvedSubId, auditName, cmdsToRun);

  const ppCredentials = getPPCredentials(credentials);

  runAllCommands(cmdsToRun, credentials, ppCredentials, hcloudToken, (cmd, _count) => {
    const done = cmdsToRun.indexOf(cmd) + 1;
    updateAuditStep(audit.id, cmd, done).catch(e => console.warn('[audit-executor] updateAuditStep failed:', e));
  })
    .then(async ({ findings, ran, errors, ppErrors, hetznerErrors, resourcesScanned }) => {
      // runAllCommands never rejects — it collects per-command failures into
      // these three buckets and resolves normally. Discarding them meant an
      // audit in which every single command failed was still stored as
      // 'completed' with 0 findings, indistinguishable from a clean scan of a
      // healthy subscription.
      const allErrors = [...errors, ...ppErrors, ...hetznerErrors];

      if (ran.length === 0 && allErrors.length > 0) {
        const message = `All ${cmdsToRun.length} command(s) failed: ${allErrors.join('; ')}`;
        await failAudit(audit.id, message);
        await notifyFailure(auditName, message);
        return;
      }

      if (findings.length > 0) await insertFindings(audit.id, findings);
      const crit = findings.filter(f => f.severity === 'Critical').length;
      const warn = findings.filter(f => f.severity === 'Warning').length;
      const info = findings.filter(f => f.severity === 'Info').length;
      const note = allErrors.length > 0
        ? `${allErrors.length} of ${cmdsToRun.length} command(s) failed: ${allErrors.join('; ')}`
        : undefined;
      if (note) console.warn(`[audit-executor] audit ${audit.id} partially failed — ${note}`);
      await updateAuditCounts(audit.id, crit, warn, info, ran, resourcesScanned, note);

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
      await failAudit(audit.id, String(e));
      await notifyFailure(auditName, String(e));
    });

  return { auditId: audit.id };
}
