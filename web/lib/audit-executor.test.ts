import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ALL_COMMANDS, HETZNER_COMMANDS } from './btg-commands';

// runAllCommands shells out to the real Go binary; stub it so each test can
// dictate exactly which commands "succeeded" and which failed.
const runAllCommands = vi.hoisted(() => vi.fn());
vi.mock('./btg-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./btg-runner')>()),
  runAllCommands,
}));

import { getDB, getAudit } from './db';
import { executeAudit, AuditExecutorError } from './audit-executor';

const SUB = 'sub-exec-test';

function runResult(over: Partial<{
  findings: unknown[]; ran: string[]; errors: string[];
  ppErrors: string[]; hetznerErrors: string[]; resourcesScanned: number;
}> = {}) {
  return {
    findings: [], ran: [], errors: [], ppErrors: [], hetznerErrors: [],
    resourcesScanned: 0, ...over,
  };
}

/** executeAudit deliberately returns as soon as the audit row exists and
 * finishes the run in a detached promise chain, so a test has to wait for
 * that chain to land rather than for executeAudit itself. */
async function waitForStatus(auditId: string, statuses: string[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const audit = await getAudit(auditId);
    if (audit && statuses.includes(audit.status)) return audit;
    if (Date.now() > deadline) {
      throw new Error(`audit ${auditId} still '${audit?.status}' after ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
}

const ENV_KEYS = [
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SUBSCRIPTION_ID',
  'HCLOUD_TOKEN', 'NOTIFICATION_EMAILS', 'ADMIN_EMAIL',
] as const;
const saved: Record<string, string | undefined> = {};

describe('executeAudit — command failures are not silently successful', () => {
  beforeEach(async () => {
    runAllCommands.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    // Credentials good enough to get past the guards.
    process.env.AZURE_TENANT_ID = 'tenant';
    process.env.AZURE_CLIENT_ID = 'client';
    process.env.AZURE_CLIENT_SECRET = 'secret';
    process.env.AZURE_SUBSCRIPTION_ID = 'azure-sub';
    process.env.HCLOUD_TOKEN = 'hetzner-token';
    // No recipients — keeps the mailer entirely out of these tests.
    process.env.NOTIFICATION_EMAILS = '';
    process.env.ADMIN_EMAIL = '';

    const db = await getDB();
    const { rows } = await db.query('SELECT current_database() as name');
    if (!String(rows[0].name).endsWith('_test')) {
      throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
    }
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await db.query(
      `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, client_secret, is_active)
       VALUES ($1, 'Test Sub', 'azure-sub', 'tenant', 'client', 'secret', true)`,
      [SUB]
    );
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('marks the audit failed when every command failed', async () => {
    runAllCommands.mockResolvedValue(runResult({
      ran: [],
      errors: ['storage: az login failed', 'nsg: az login failed'],
    }));

    const { auditId } = await executeAudit(SUB, ['storage', 'nsg']);
    const audit = await waitForStatus(auditId, ['failed', 'completed']);

    // The regression: this was stored as 'completed' with 0 findings, so a
    // total credential outage was indistinguishable from a clean subscription.
    expect(audit.status).toBe('failed');
    expect(audit.error_message).toContain('az login failed');
    expect(audit.total_findings).toBe(0);
  });

  it('records a partial failure on an otherwise completed audit', async () => {
    runAllCommands.mockResolvedValue(runResult({
      ran: ['storage'],
      findings: [{
        service: 'storage', resource: 'acct', environment: '', severity: 'Critical',
        category: '', description: 'public access', recommendation: 'disable',
        owner: '', location: '', monthly_cost: null, monthly_saving: null,
      }],
      hetznerErrors: ['hetzner-servers: HCLOUD_TOKEN not set'],
      resourcesScanned: 3,
    }));

    const { auditId } = await executeAudit(SUB, ['storage', 'hetzner-servers']);
    const audit = await waitForStatus(auditId, ['completed', 'failed']);

    expect(audit.status).toBe('completed');
    expect(audit.total_findings).toBe(1);
    expect(audit.critical_count).toBe(1);
    // Still surfaced, rather than thrown away.
    expect(audit.error_message).toContain('HCLOUD_TOKEN not set');
    expect(audit.error_message).toContain('1 of 2');
  });

  it('leaves a fully successful audit with no error message', async () => {
    runAllCommands.mockResolvedValue(runResult({ ran: ['storage'], resourcesScanned: 2 }));

    const { auditId } = await executeAudit(SUB, ['storage']);
    const audit = await waitForStatus(auditId, ['completed', 'failed']);

    expect(audit.status).toBe('completed');
    expect(audit.error_message).toBe('');
  });
});

describe('executeAudit — credential guards', () => {
  beforeEach(async () => {
    runAllCommands.mockReset();
    runAllCommands.mockResolvedValue(runResult({ ran: ['hetzner-servers'] }));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.AZURE_TENANT_ID = 'tenant';
    process.env.AZURE_CLIENT_ID = 'client';
    process.env.AZURE_CLIENT_SECRET = 'secret';
    process.env.NOTIFICATION_EMAILS = '';
    process.env.ADMIN_EMAIL = '';

    const db = await getDB();
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await db.query(
      `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, client_secret, is_active)
       VALUES ($1, 'Test Sub', 'azure-sub', 'tenant', 'client', 'secret', true)`,
      [SUB]
    );
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('rejects a Hetzner-only run with no HCLOUD_TOKEN', async () => {
    delete process.env.HCLOUD_TOKEN;
    // Previously this skipped the Azure guard and ran anyway, so every
    // command failed for want of a token nobody had checked for.
    await expect(executeAudit(SUB, [...HETZNER_COMMANDS])).rejects.toThrow(AuditExecutorError);
    await expect(executeAudit(SUB, [...HETZNER_COMMANDS])).rejects.toThrow(/HCLOUD_TOKEN/);
  });

  it('still allows a default all-commands run with no HCLOUD_TOKEN', async () => {
    delete process.env.HCLOUD_TOKEN;
    // ALL_COMMANDS includes the Hetzner commands, so gating on "any Hetzner
    // command present" would break every default audit on an Azure-only
    // deployment. The Hetzner failures become a partial failure instead.
    await expect(executeAudit(SUB, [...ALL_COMMANDS])).resolves.toHaveProperty('auditId');
  });
});
