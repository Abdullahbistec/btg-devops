import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { makeSessionToken } from './auth';
import { recordAuditLog, listAuditLog } from './audit-log';

const SECRET = 'test-session-secret';
const SAVED = { ...process.env };

async function reset() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM audit_log');
}

function signedRequest(email: string, ip = '203.0.113.4') {
  return new NextRequest('http://localhost/api/audits/run', {
    method: 'POST',
    headers: {
      cookie: `btg_identity=${email}; btg_session=${makeSessionToken(SECRET, email)}`,
      'x-forwarded-for': ip,
    },
  });
}

describe('recordAuditLog', () => {
  beforeEach(async () => {
    await reset();
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => { process.env = { ...SAVED }; vi.restoreAllMocks(); });

  it('records the verified actor, the action, the detail and the address', async () => {
    await recordAuditLog(signedRequest('admin@example.com'), 'audits.run', { subscription_id: 'sub-1' });

    const [row] = await listAuditLog();
    expect(row.actor).toBe('admin@example.com');
    expect(row.action).toBe('audits.run');
    expect(JSON.parse(row.detail)).toEqual({ subscription_id: 'sub-1' });
    expect(row.ip).toBe('203.0.113.4');
  });

  it('records an empty actor rather than dropping the entry when the session is unverified', async () => {
    const anon = new NextRequest('http://localhost/api/audits/run', { method: 'POST' });
    await recordAuditLog(anon, 'audits.run');

    const [row] = await listAuditLog();
    expect(row.actor).toBe('');
    expect(row.action).toBe('audits.run');
  });

  it('returns newest first', async () => {
    await recordAuditLog(signedRequest('a@example.com'), 'first');
    await recordAuditLog(signedRequest('b@example.com'), 'second');

    const rows = await listAuditLog();
    expect(rows.map(r => r.action)).toEqual(['second', 'first']);
  });

  it('never throws, so a logging failure cannot fail the action it describes', async () => {
    // Logging is not the point of the request. If the insert fails, the scan
    // still needs to run — the alternative is an outage caused by bookkeeping.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(recordAuditLog(signedRequest('admin@example.com'), 'bad.detail', circular)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});
