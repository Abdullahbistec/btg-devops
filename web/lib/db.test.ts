import { describe, it, expect, beforeEach } from 'vitest';

import { getDB, insertFindings, saveCostSnapshot, getCostSnapshotHistory } from './db';

function seedAuditAndSubscription() {
  const db = getDB();
  db.prepare(`
    INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
    VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
  `).run();
  db.prepare(`
    INSERT INTO audits (id, subscription_id, name, status)
    VALUES ('audit-1', 'sub-1', 'Test Audit', 'completed')
  `).run();
}

describe('insertFindings — location and cost columns', () => {
  beforeEach(() => {
    const db = getDB();
    const dbList = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
    const mainDb = dbList.find(d => d.name === 'main');
    if (mainDb && mainDb.file !== '') {
      throw new Error(`db.test.ts refusing to run destructive setup against a non-in-memory database: ${mainDb.file}`);
    }
    db.exec('DELETE FROM findings');
    db.exec('DELETE FROM audits');
    db.exec('DELETE FROM subscriptions');
    seedAuditAndSubscription();
  });

  it('round-trips location, monthly_cost, and monthly_saving', () => {
    insertFindings('audit-1', [{
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

    const db = getDB();
    const row = db.prepare('SELECT * FROM findings').get() as any;
    expect(row.location).toBe('eastus');
    expect(row.monthly_cost).toBe(12.5);
    expect(row.monthly_saving).toBe(12.5);
  });

  it('defaults location to empty string and cost/saving to null when absent', () => {
    insertFindings('audit-1', [{
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

    const db = getDB();
    const row = db.prepare('SELECT * FROM findings').get() as any;
    expect(row.location).toBe('');
    expect(row.monthly_cost).toBeNull();
    expect(row.monthly_saving).toBeNull();
  });
});

describe('saveCostSnapshot — history', () => {
  beforeEach(() => {
    const db = getDB();
    const dbList = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
    const mainDb = dbList.find(d => d.name === 'main');
    if (mainDb && mainDb.file !== '') {
      throw new Error(`db.test.ts refusing to run destructive setup against a non-in-memory database: ${mainDb.file}`);
    }
    db.exec('DELETE FROM cost_snapshot_history');
    db.exec('DELETE FROM cost_snapshots');
    db.exec('DELETE FROM findings');
    db.exec('DELETE FROM audits');
    db.exec('DELETE FROM subscriptions');
    db.prepare(`
      INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
      VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
    `).run();
  });

  it('writes a history row alongside the latest-value row', () => {
    saveCostSnapshot('sub-1', {
      totalCost: 100, currency: 'USD',
      byService: [{ name: 'Virtual Machines', cost: 60 }, { name: 'Storage', cost: 40 }],
      byResourceGroup: [{ name: 'rg-1', cost: 100 }],
    });

    const history = getDB().prepare('SELECT * FROM cost_snapshot_history WHERE subscription_id = ?').all('sub-1') as {
      subscription_id: string; snapshot_date: string; total_cost: number; currency: string; by_service: string; fetched_at: string;
    }[];
    expect(history).toHaveLength(1);
    expect(history[0].total_cost).toBe(100);
    expect(history[0].currency).toBe('USD');
    expect(JSON.parse(history[0].by_service)).toEqual([{ name: 'Virtual Machines', cost: 60 }, { name: 'Storage', cost: 40 }]);
    expect(history[0].snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('overwrites the same day\'s row on a second refresh the same day, not a duplicate', () => {
    saveCostSnapshot('sub-1', { totalCost: 100, currency: 'USD', byService: [], byResourceGroup: [] });
    saveCostSnapshot('sub-1', { totalCost: 150, currency: 'USD', byService: [{ name: 'VMs', cost: 150 }], byResourceGroup: [] });

    const history = getDB().prepare('SELECT * FROM cost_snapshot_history WHERE subscription_id = ?').all('sub-1') as { total_cost: number }[];
    expect(history).toHaveLength(1);
    expect(history[0].total_cost).toBe(150);
  });

  it('does not carry by_resource_group into history', () => {
    saveCostSnapshot('sub-1', {
      totalCost: 100, currency: 'USD', byService: [],
      byResourceGroup: [{ name: 'rg-1', cost: 100 }],
    });
    const cols = getDB().prepare('PRAGMA table_info(cost_snapshot_history)').all() as { name: string }[];
    expect(cols.map(c => c.name)).not.toContain('by_resource_group');
  });

  it('getCostSnapshotHistory returns rows oldest-to-newest within the day window', () => {
    const db = getDB();
    // Insert two history rows directly, one 5 days ago (in-window for days=7,
    // out for days=3) and one today, to test both ordering and the day filter.
    db.prepare(`
      INSERT INTO cost_snapshot_history (subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)
      VALUES ('sub-1', date('now', '-5 days'), 80, 'USD', '[]', datetime('now', '-5 days'))
    `).run();
    saveCostSnapshot('sub-1', { totalCost: 120, currency: 'USD', byService: [{ name: 'VMs', cost: 120 }], byResourceGroup: [] });

    const sevenDays = getCostSnapshotHistory('sub-1', 7);
    expect(sevenDays).toHaveLength(2);
    expect(sevenDays[0].total_cost).toBe(80);   // older row first
    expect(sevenDays[1].total_cost).toBe(120);  // today's row last

    const threeDays = getCostSnapshotHistory('sub-1', 3);
    expect(threeDays).toHaveLength(1);
    expect(threeDays[0].total_cost).toBe(120);
  });
});
