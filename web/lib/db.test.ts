import { describe, it, expect, beforeEach } from 'vitest';

import { getDB, insertFindings, saveCostSnapshot, getCostSnapshotHistory, getStaleRunningAudits, saveHetznerCostSnapshot, getHetznerCostSnapshot, getHetznerCostHistory , saveHetznerReconstructedHistory, hasMeasuredHetznerSnapshotToday, hasRunningAudit} from './db';

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
      confidence: null,
      reasoning: null,
      currency: null,
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
      confidence: null,
      reasoning: null,
      currency: null,
    }]);

    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings');
    const row = rows[0];
    expect(row.location).toBe('');
    expect(row.monthly_cost).toBeNull();
    expect(row.monthly_saving).toBeNull();
  });

  it('round-trips confidence and reasoning from the Claude-based analysis engine', async () => {
    await insertFindings('audit-1', [{
      service: 'Storage',
      resource: 'acct1',
      environment: '',
      severity: 'Critical',
      category: 'HTTPS Not Enforced',
      description: 'desc',
      recommendation: 'rec',
      owner: '',
      location: '',
      monthly_cost: null,
      monthly_saving: null,
      confidence: 0.87,
      reasoning: 'the account explicitly disables HTTPS-only traffic',
      currency: null,
    }]);

    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings');
    const row = rows[0];
    expect(Number(row.confidence)).toBe(0.87);
    expect(row.reasoning).toBe('the account explicitly disables HTTPS-only traffic');
  });

  it('defaults confidence and reasoning to null when absent (the rule-based fallback path)', async () => {
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
      confidence: null,
      reasoning: null,
      currency: null,
    }]);

    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings');
    const row = rows[0];
    expect(row.confidence).toBeNull();
    expect(row.reasoning).toBeNull();
  });

  it('round-trips currency when present', async () => {
    await insertFindings('audit-1', [{
      service: 'Hetzner Volumes',
      resource: 'vol-1',
      environment: '',
      severity: 'Warning',
      category: 'Idle Volume',
      description: 'desc',
      recommendation: 'rec',
      owner: '',
      location: '',
      monthly_cost: 5.99,
      monthly_saving: 5.99,
      confidence: null,
      reasoning: null,
      currency: 'USD',
    }]);

    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings');
    const row = rows[0];
    expect(row.currency).toBe('USD');
  });

  it('leaves currency NULL when absent, rather than backfilling a guess', async () => {
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
      confidence: null,
      reasoning: null,
      currency: null,
    }]);

    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings');
    const row = rows[0];
    expect(row.currency).toBeNull();
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
    expect(history[0].by_service).toEqual([{ name: 'Virtual Machines', cost: 60 }, { name: 'Storage', cost: 40 }]);
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
      VALUES ('sub-1', to_char(now() - interval '5 days', 'YYYY-MM-DD'), 80, 'USD', '[]', now() - interval '5 days')
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

describe('findings table migrations', () => {
  beforeEach(async () => {
    await assertTestDatabase();
  });

  it('findings table has confidence and reasoning columns after migration', async () => {
    const db = await getDB();
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'findings' AND column_name IN ('confidence', 'reasoning')`
    );
    const names = rows.map((r: { column_name: string }) => r.column_name).sort();
    expect(names).toEqual(['confidence', 'reasoning']);
  });
});

describe('getStaleRunningAudits', () => {
  beforeEach(async () => {
    await assertTestDatabase();
    const db = await getDB();
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await db.query(`
      INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
      VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
    `);
  });

  it('returns a running audit started well past the max age, but not a recent one', async () => {
    const db = await getDB();
    await db.query(`
      INSERT INTO audits (id, subscription_id, name, status, started_at)
      VALUES
        ('audit-old', 'sub-1', 'Orphaned Audit', 'running', now() - interval '20 hours'),
        ('audit-new', 'sub-1', 'Fresh Audit', 'running', now() - interval '5 minutes')
    `);

    const stale = await getStaleRunningAudits(12);
    expect(stale.map(a => a.id)).toEqual(['audit-old']);
  });

  it('ignores audits that already completed or failed, however old', async () => {
    const db = await getDB();
    await db.query(`
      INSERT INTO audits (id, subscription_id, name, status, started_at)
      VALUES ('audit-done', 'sub-1', 'Old Completed Audit', 'completed', now() - interval '20 hours')
    `);

    const stale = await getStaleRunningAudits(12);
    expect(stale).toHaveLength(0);
  });
});

describe('hasRunningAudit', () => {
  beforeEach(async () => {
    await assertTestDatabase();
    const db = await getDB();
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await db.query(`
      INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
      VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
    `);
  });

  // Guards the scheduler's daily cost refresh and backfill heal: an audit's
  // analyzer chain runs unawaited in the background and hits the same
  // Cost Management API those jobs do, so starting them while an audit is
  // mid-run is exactly the concurrent-caller pileup that produces 429s.
  it('is true while an audit is running', async () => {
    const db = await getDB();
    await db.query(`
      INSERT INTO audits (id, subscription_id, name, status)
      VALUES ('audit-1', 'sub-1', 'In Progress', 'running')
    `);

    expect(await hasRunningAudit()).toBe(true);
  });

  it('is false when every audit has completed, failed, or is merely pending', async () => {
    const db = await getDB();
    await db.query(`
      INSERT INTO audits (id, subscription_id, name, status)
      VALUES
        ('audit-done', 'sub-1', 'Done', 'completed'),
        ('audit-failed', 'sub-1', 'Failed', 'failed'),
        ('audit-pending', 'sub-1', 'Pending', 'pending')
    `);

    expect(await hasRunningAudit()).toBe(false);
  });

  it('is false with no audits at all', async () => {
    expect(await hasRunningAudit()).toBe(false);
  });
});

describe('hasMeasuredHetznerSnapshotToday', () => {
  it('is false when today only has a reconstructed row', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, reconstructed, fetched_at)
       VALUES ('recon-today', 100, 'USD', '{}', '{}', '[]', true, now())`
    );

    // A derived figure must never satisfy the daily-refresh guard, or the
    // scheduler skips and today stays reconstructed forever.
    expect(await hasMeasuredHetznerSnapshotToday()).toBe(false);
  });

  it('is true once a measured row exists for today', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, reconstructed, fetched_at)
       VALUES ('measured-today', 100, 'USD', '{}', '{}', '[]', false, now())`
    );

    expect(await hasMeasuredHetznerSnapshotToday()).toBe(true);
  });

  it('is false when the only measured row is from a previous day', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, reconstructed, fetched_at)
       VALUES ('measured-old', 100, 'USD', '{}', '{}', '[]', false, now() - interval '2 days')`
    );

    expect(await hasMeasuredHetznerSnapshotToday()).toBe(false);
  });
});

describe('saveHetznerReconstructedHistory', () => {
  it('writes one flagged row per day and is idempotent across re-runs', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');

    const points = [
      { day: '2026-09-01', total_monthly: 100, currency: 'USD' },
      { day: '2026-09-02', total_monthly: 120, currency: 'USD' },
    ];
    await saveHetznerReconstructedHistory(points);
    await saveHetznerReconstructedHistory(points); // re-running must not duplicate

    const { rows } = await db.query('SELECT reconstructed FROM hetzner_cost_snapshots');
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { reconstructed: boolean }) => r.reconstructed)).toBe(true);
  });

  it('never overwrites a measured snapshot with a reconstructed one', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    // A real measurement taken on 2026-09-01.
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, reconstructed, fetched_at)
       VALUES ('measured', 999, 'USD', '{}', '{}', '[]', false, '2026-09-01T12:00:00Z')`
    );

    await saveHetznerReconstructedHistory([{ day: '2026-09-01', total_monthly: 100, currency: 'USD' }]);

    // A derived figure must never displace something actually observed.
    const points = await getHetznerCostHistory(3650);
    const sept1 = points.find(p => p.day === '2026-09-01');
    expect(sept1?.total_monthly).toBeCloseTo(999, 2);
  });
});

describe('getHetznerCostHistory', () => {
  // Refreshes run several times a day (the Refresh button plus the daily
  // scheduler), so the raw table holds many rows per day. A run-rate chart
  // wants one point per day, or the line shows vertical clusters that look
  // like volatility where none exists.
  it('collapses multiple same-day snapshots to the latest one per day', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    const row = (id: string, total: number, ts: string) => db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, fetched_at)
       VALUES ($1, $2, 'USD', '{}', '{}', '[]', $3)`,
      [id, total, ts]
    );
    await row('h1', 100, '2026-09-10T02:00:00Z');
    await row('h2', 111, '2026-09-11T02:00:00Z'); // earlier that day
    await row('h3', 222, '2026-09-11T20:00:00Z'); // later same day — this one wins

    const points = await getHetznerCostHistory(30);

    expect(points).toHaveLength(2);
    expect(points[1].total_monthly).toBeCloseTo(222, 2);
  });

  // Regression: the SELECT once omitted this column entirely, so every point
  // came back with reconstructed === undefined and the UI counted 179 derived
  // days as measured. The data was right; the projection was not.
  it('reports whether each point was measured or reconstructed', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, reconstructed, fetched_at)
       VALUES ('r1', 10, 'USD', '{}', '{}', '[]', true,  '2026-09-05T12:00:00Z'),
              ('m1', 20, 'USD', '{}', '{}', '[]', false, '2026-09-06T12:00:00Z')`
    );

    const points = await getHetznerCostHistory(3650);

    expect(points.find(p => p.day === '2026-09-05')?.reconstructed).toBe(true);
    expect(points.find(p => p.day === '2026-09-06')?.reconstructed).toBe(false);
  });

  it('returns points oldest first, so a chart can plot them directly', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, fetched_at)
       VALUES ('b1', 50, 'USD', '{}', '{}', '[]', '2026-09-09T02:00:00Z'),
              ('b2', 60, 'USD', '{}', '{}', '[]', '2026-09-10T02:00:00Z')`
    );

    const points = await getHetznerCostHistory(30);

    expect(points.map(p => p.total_monthly)).toEqual([50, 60]);
  });

  it('excludes snapshots older than the requested window', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');
    await db.query(
      `INSERT INTO hetzner_cost_snapshots (id, total_monthly, currency, by_category, by_type, unpriced, fetched_at)
       VALUES ('old', 999, 'USD', '{}', '{}', '[]', now() - interval '400 days'),
              ('new', 123, 'USD', '{}', '{}', '[]', now())`
    );

    const points = await getHetznerCostHistory(30);

    expect(points).toHaveLength(1);
    expect(points[0].total_monthly).toBeCloseTo(123, 2);
  });
});

describe('hetzner cost snapshots', () => {
  it('round-trips a snapshot and returns the newest', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');

    await saveHetznerCostSnapshot({
      totalMonthly: 246.89, currency: 'USD',
      byCategory: { servers: 213.35, volumes: 24.54 },
      byType: { cpx11: { count: 1, monthly_total: 5.99 } },
    });

    const snap = await getHetznerCostSnapshot();
    expect(snap?.total_monthly).toBeCloseTo(246.89, 2);
    expect(snap?.currency).toBe('USD');
    expect(snap!.by_category.servers).toBeCloseTo(213.35, 2);
  });

  it('round-trips a non-empty unpriced list so a pricing gap stays visible', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');

    await saveHetznerCostSnapshot({
      totalMonthly: 100,
      currency: 'USD',
      byCategory: { servers: 100 },
      byType: { cpx11: { count: 1, monthly_total: 100 } },
      unpriced: ['server web-1 (type unknown-type)', 'primary ip pip-1 (type ipv4)'],
    });

    const snap = await getHetznerCostSnapshot();
    const unpriced = snap!.unpriced;
    expect(unpriced).toEqual(['server web-1 (type unknown-type)', 'primary ip pip-1 (type ipv4)']);
  });

  it('defaults unpriced to an empty list when not provided', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');

    await saveHetznerCostSnapshot({
      totalMonthly: 100, currency: 'USD',
      byCategory: { servers: 100 }, byType: {},
    });

    const snap = await getHetznerCostSnapshot();
    expect(snap!.unpriced).toEqual([]);
  });
});
