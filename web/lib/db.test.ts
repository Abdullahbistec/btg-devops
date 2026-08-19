import { describe, it, expect, beforeEach } from 'vitest';

import { getDB, insertFindings } from './db';

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
