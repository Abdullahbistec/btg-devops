import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { makeSessionToken } from './auth';
import { GET } from '@/app/api/dashboard/route';

const SUB = 'sub-trend-test';
const SESSION_SECRET = 'test-session-secret';
const ADMIN_EMAIL = 'admin@example.com';

/** Seeds `count` completed audits, oldest first, with total_findings equal to
 * the audit's 1-based position so a pairing is trivially readable: a pair
 * exactly one 10-run window apart differs by exactly 10. */
async function seedAudits(count: number) {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM findings');
  await db.query('DELETE FROM audits');
  await db.query('DELETE FROM subscriptions');
  await db.query(
    `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, is_active)
     VALUES ($1, 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid', true)`,
    [SUB]
  );

  for (let i = 1; i <= count; i++) {
    const stamp = `2026-08-${String(i).padStart(2, '0')} 03:00:00`;
    await db.query(
      `INSERT INTO audits
         (id, subscription_id, name, status, started_at, completed_at, total_findings, commands_run)
       VALUES ($1, $2, $3, 'completed', $4, $4, $5, '["storage"]')`,
      [`audit-${String(i).padStart(3, '0')}`, SUB, `Audit ${i}`, stamp, i]
    );
  }
}

async function trendFrom() {
  const cookie = `btg_identity=${ADMIN_EMAIL}; btg_session=${makeSessionToken(SESSION_SECRET, ADMIN_EMAIL)}`;
  const res = await GET(new NextRequest('http://localhost/api/dashboard', { headers: { cookie } }));
  const body = await res.json();
  if (res.status !== 200) throw new Error(`dashboard returned ${res.status}: ${body?.error}`);
  return body.trend as { total_findings: number; prev_total_findings: number | null }[];
}

describe('dashboard trend — window pairing', () => {
  const ORIGINAL_ADMIN = process.env.ADMIN_EMAIL;
  const ORIGINAL_SECRET = process.env.SESSION_SECRET;

  beforeEach(async () => {
    process.env.ADMIN_EMAIL = ADMIN_EMAIL;
    process.env.SESSION_SECRET = SESSION_SECRET;
    const db = await getDB();
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN;
    if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = ORIGINAL_SECRET;
  });

  it('pairs each run with the one exactly 10 runs earlier when both windows are full', async () => {
    await seedAudits(20);
    const trend = await trendFrom();

    expect(trend).toHaveLength(10);
    for (const row of trend) {
      expect(row.prev_total_findings).toBe(row.total_findings - 10);
    }
  });

  it('keeps pairs 10 runs apart when the previous window is short', async () => {
    // 15 audits: the previous window holds only 5 runs, and it is short at
    // its OLDEST end. The regression paired previous[i] with current[i]
    // directly, which made the five oldest pairs an arbitrary 5 runs apart
    // and left the five NEWEST runs with no comparison at all.
    await seedAudits(15);
    const trend = await trendFrom();

    expect(trend).toHaveLength(10);
    for (const row of trend) {
      if (row.prev_total_findings !== null) {
        expect(row.prev_total_findings).toBe(row.total_findings - 10);
      }
    }

    // The newest runs (11..15) are the ones that have a counterpart 10 back
    // (runs 1..5), so they must be the pairs that exist.
    const paired = trend.filter(r => r.prev_total_findings !== null).map(r => r.total_findings);
    expect(paired).toEqual([11, 12, 13, 14, 15]);
  });

  it('reports no comparison at all when there is under one window of history', async () => {
    await seedAudits(6);
    const trend = await trendFrom();

    expect(trend).toHaveLength(6);
    expect(trend.every(r => r.prev_total_findings === null)).toBe(true);
  });
});
