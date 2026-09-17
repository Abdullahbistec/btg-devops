import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  getDB, createCostFetchRequest, createCostBackfillRequest, getPendingCostFetchRequestFor,
} from './db';
import { makeSessionToken } from './auth';
import { POST } from '@/app/api/cost-requests/route';

const SUB = 'sub-costreq-test';

async function reset() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  // Same guard as db.test.ts — never mutate a non-test database.
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM cost_fetch_requests');
  await db.query('DELETE FROM findings');
  await db.query('DELETE FROM audits');
  await db.query('DELETE FROM users');
  await db.query('DELETE FROM subscriptions');
  await db.query(
    `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id, is_active)
     VALUES ($1, 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid', true)`,
    [SUB]
  );
}

describe('getPendingCostFetchRequestFor — dedupe is per request type', () => {
  beforeEach(reset);

  it('does not report a pending refresh as a pending backfill', async () => {
    await createCostFetchRequest(SUB);

    expect(await getPendingCostFetchRequestFor(SUB, 'refresh')).not.toBeNull();
    // The regression: an in-flight refresh made a backfill look already
    // queued, so the route returned 202 and the backfill never ran.
    expect(await getPendingCostFetchRequestFor(SUB, 'backfill')).toBeNull();
  });

  it('does not report a pending backfill as a pending refresh', async () => {
    await createCostBackfillRequest(SUB, 6);

    expect(await getPendingCostFetchRequestFor(SUB, 'backfill')).not.toBeNull();
    expect(await getPendingCostFetchRequestFor(SUB, 'refresh')).toBeNull();
  });

  it('still dedupes a second request of the same type', async () => {
    const first = await createCostFetchRequest(SUB);
    const found = await getPendingCostFetchRequestFor(SUB, 'refresh');
    expect(found?.id).toBe(first.id);
  });
});

describe('POST /api/cost-requests — admin only', () => {
  const ORIGINAL_ADMIN = process.env.ADMIN_EMAIL;
  const ORIGINAL_SECRET = process.env.SESSION_SECRET;
  const SECRET = 'test-session-secret';

  beforeEach(async () => {
    await reset();
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.SESSION_SECRET = SECRET;
    const db = await getDB();
    await db.query(
      `INSERT INTO users (id, email, name, password_hash, role, status)
       VALUES ('u-viewer', 'viewer@example.com', 'Viewer', 'x', 'viewer', 'active')`
    );
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN;
    if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ORIGINAL_SECRET;
  });

  // A verified session — btg_identity plus the matching btg_session HMAC —
  // not just the forgeable plaintext identity cookie the C2 bug used to trust.
  function request(identity: string, body: unknown = {}) {
    const cookie = identity
      ? `btg_identity=${identity}; btg_session=${makeSessionToken(SECRET, identity)}`
      : '';
    return new NextRequest('http://localhost/api/cost-requests', {
      method: 'POST',
      headers: cookie
        ? { 'content-type': 'application/json', cookie }
        : { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request with no cookies at all with 403, never admin', async () => {
    // The C1 regression: !identity used to short-circuit straight to 'admin'.
    const res = await POST(request('', { backfillMonths: 6 }));
    expect(res.status).toBe(403);
  });

  it('rejects a forged plaintext identity cookie with no valid session', async () => {
    // The C2 regression: btg_session was never checked, so setting
    // btg_identity alone used to be enough to impersonate the admin.
    const forged = new NextRequest('http://localhost/api/cost-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'btg_identity=admin@example.com' },
      body: JSON.stringify({ backfillMonths: 6 }),
    });
    expect((await POST(forged)).status).toBe(403);
  });

  it('rejects an active viewer with 403', async () => {
    // This route makes live Azure Cost Management calls — one per month for
    // a backfill — against a tight rate limit. Every sibling mutating route
    // is admin-only; this one was reachable by any signed-in viewer.
    const res = await POST(request('viewer@example.com', { backfillMonths: 6 }));
    expect(res.status).toBe(403);

    // Nothing was queued and nothing was called.
    const db = await getDB();
    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM cost_fetch_requests');
    expect(rows[0].c).toBe(0);
  });

  it('lets an admin through the gate', async () => {
    const res = await POST(request('admin@example.com'));
    // Not 403. The request itself will fail past the gate for want of real
    // Azure credentials, which is fine — the gate is what's under test.
    expect(res.status).not.toBe(403);
  });
});
