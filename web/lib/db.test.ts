import { describe, it, expect, beforeEach } from 'vitest';

import { getDB, insertFindings, saveCostSnapshot, getCostSnapshotHistory } from './db';

/** Refuses to run destructive setup against anything that isn't clearly a
 * disposable test database — same intent as the old SQLite guard (which
 * checked for an in-memory, file-less database), adapted for Postgres
 * (see vitest.config.ts: DATABASE_URL is pointed at btg_devops_test). */
async function assertTestDatabase() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  const name = rows[0]?.name as string;
  if (!name.endsWith('_test')) {
    throw new Error(`db.test.ts refusing to run destructive setup against a non-test database: ${name}`);
  }
}

async function seedAuditAndSubscription() {
  const db = await getDB();
  await db.query(`
    INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
    VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
  `);
  await db.query(`
    INSERT INTO audits (id, subscription_id, name, status)
    VALUES ('audit-1', 'sub-1', 'Test Audit', 'completed')
  `);
}

describe('insertFindings — location and cost columns', () => {
  beforeEach(async () => {
    await assertTestDatabase();
    const db = await getDB();
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await seedAuditAndSubscription();
  });

  it('round-trips location, monthly_cost, and monthly_saving', async () => {
    await insertFindings('audit-1', [{
      service: 'Idle & Waste',
      resource: 'unused-ip',
      environment: '',
      severity: 'Critical',
      category: 'Zero Usage',
      description: 'Idle for 30 days',
      recommendation: 'Delete it',
      owner: '',
      location: 'eastus',
      monthly_cost: 12.5,
      monthly_saving: 12.5,
    }]);

    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings');
    const row = rows[0];
    expect(row.location).toBe('eastus');
    expect(Number(row.monthly_cost)).toBe(12.5);
    expect(Number(row.monthly_saving)).toBe(12.5);
  });

  it('defaults location to empty string and cost/saving to null when absent', async () => {
    await insertFindings('audit-1', [{
      service: 'IAM',
      resource: 'some-role',
      environment: '',
      severity: 'Warning',
      category: 'Overprivileged',
      description: 'desc',
      recommendation: 'rec',
      owner: '',
      location: '',
      monthly_cost: null,
      monthly_saving: null,
    }]);

    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings');
    const row = rows[0];
    expect(row.location).toBe('');
    expect(row.monthly_cost).toBeNull();
    expect(row.monthly_saving).toBeNull();
  });
});

describe('saveCostSnapshot — history', () => {
  beforeEach(async () => {
    await assertTestDatabase();
    const db = await getDB();
    await db.query('DELETE FROM cost_snapshot_history');
    await db.query('DELETE FROM cost_snapshots');
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await db.query(`
      INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
      VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
    `);
  });

  it('writes a history row alongside the latest-value row', async () => {
    await saveCostSnapshot('sub-1', {
      totalCost: 100, currency: 'USD',
      byService: [{ name: 'Virtual Machines', cost: 60 }, { name: 'Storage', cost: 40 }],
      byResourceGroup: [{ name: 'rg-1', cost: 100 }],
    });

    const db = await getDB();
    const { rows: history } = await db.query('SELECT * FROM cost_snapshot_history WHERE subscription_id = $1', ['sub-1']);
    expect(history).toHaveLength(1);
    expect(Number(history[0].total_cost)).toBe(100);
    expect(history[0].currency).toBe('USD');
    expect(JSON.parse(history[0].by_service)).toEqual([{ name: 'Virtual Machines', cost: 60 }, { name: 'Storage', cost: 40 }]);
    expect(history[0].snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('overwrites the same day\'s row on a second refresh the same day, not a duplicate', async () => {
    await saveCostSnapshot('sub-1', { totalCost: 100, currency: 'USD', byService: [], byResourceGroup: [] });
    await saveCostSnapshot('sub-1', { totalCost: 150, currency: 'USD', byService: [{ name: 'VMs', cost: 150 }], byResourceGroup: [] });

    const db = await getDB();
    const { rows: history } = await db.query('SELECT * FROM cost_snapshot_history WHERE subscription_id = $1', ['sub-1']);
    expect(history).toHaveLength(1);
    expect(Number(history[0].total_cost)).toBe(150);
  });

  it('does not carry by_resource_group into history', async () => {
    await saveCostSnapshot('sub-1', {
      totalCost: 100, currency: 'USD', byService: [],
      byResourceGroup: [{ name: 'rg-1', cost: 100 }],
    });
    const db = await getDB();
    const { rows: cols } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cost_snapshot_history'`
    );
    expect(cols.map((c: { column_name: string }) => c.column_name)).not.toContain('by_resource_group');
  });

  it('getCostSnapshotHistory returns rows oldest-to-newest within the day window', async () => {
    const db = await getDB();
    // Insert two history rows directly, one 5 days ago (in-window for days=7,
    // out for days=3) and one today, to test both ordering and the day filter.
    await db.query(`
      INSERT INTO cost_snapshot_history (subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)
      VALUES ('sub-1', to_char(now() - interval '5 days', 'YYYY-MM-DD'), 80, 'USD', '[]', to_char(now() - interval '5 days', 'YYYY-MM-DD HH24:MI:SS'))
    `);
    await saveCostSnapshot('sub-1', { totalCost: 120, currency: 'USD', byService: [{ name: 'VMs', cost: 120 }], byResourceGroup: [] });

    const sevenDays = await getCostSnapshotHistory('sub-1', 7);
    expect(sevenDays).toHaveLength(2);
    expect(Number(sevenDays[0].total_cost)).toBe(80);   // older row first
    expect(Number(sevenDays[1].total_cost)).toBe(120);  // today's row last

    const threeDays = await getCostSnapshotHistory('sub-1', 3);
    expect(threeDays).toHaveLength(1);
    expect(Number(threeDays[0].total_cost)).toBe(120);
  });
});
