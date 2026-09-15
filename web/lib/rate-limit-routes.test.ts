import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as register } from '@/app/api/auth/register/route';

const SAVED = { ...process.env };

async function reset() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM rate_limit_hits');
  await db.query('DELETE FROM otp_codes');
  await db.query('DELETE FROM users');
}

function loginRequest(ip: string, email = 'nobody@example.com') {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: 'wrong-password' }),
  });
}

describe('POST /api/auth/login — rate limited', () => {
  beforeEach(async () => {
    await reset();
    process.env.SESSION_SECRET = 'test-session-secret';
    process.env.ADMIN_EMAIL = 'admin@example.com';
  });
  afterEach(() => { process.env = { ...SAVED }; });

  it('starts returning 429 once one address exceeds the limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await login(loginRequest('203.0.113.4'))).status);
    }
    // First 10 are ordinary auth failures (401), the rest are throttled.
    expect(statuses.slice(0, 10).every(s => s !== 429)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('sets Retry-After on the 429', async () => {
    let res!: Response;
    for (let i = 0; i < 11; i++) res = await login(loginRequest('203.0.113.9'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not let one address exhaust another address\'s budget', async () => {
    // Distinct emails: the point here is IP isolation specifically, which the
    // per-account bucket (covered by the next test) would otherwise mask —
    // reusing one email would exhaust *that* bucket across both addresses.
    for (let i = 0; i < 11; i++) await login(loginRequest('203.0.113.4', 'victim-a@example.com'));
    expect((await login(loginRequest('198.51.100.7', 'victim-b@example.com'))).status).not.toBe(429);
  });

  it('throttles guesses against one account even when the source address rotates', async () => {
    // Password spraying from a botnet: a per-IP limit alone never fires.
    for (let i = 0; i < 11; i++) {
      await login(loginRequest(`198.51.100.${i}`, 'victim@example.com'));
    }
    expect((await login(loginRequest('203.0.113.200', 'victim@example.com'))).status).toBe(429);
  });
});

describe('POST /api/auth/register — rate limited', () => {
  beforeEach(async () => {
    await reset();
    process.env.ADMIN_EMAIL = 'admin@example.com';
  });
  afterEach(() => { process.env = { ...SAVED }; });

  it('stops one address flooding the users table', async () => {
    const attempt = (n: number) => register(new NextRequest('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
      body: JSON.stringify({ email: `flood${n}@example.com`, name: `Flood ${n}`, password: 'password123' }),
    }));

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await attempt(i)).status);

    expect(statuses.slice(0, 5).every(s => s !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);

    const db = await getDB();
    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM users');
    expect(rows[0].c).toBe(5);
  });
});
