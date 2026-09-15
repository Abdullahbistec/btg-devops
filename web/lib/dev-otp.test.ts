import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { hashPassword } from './auth';
import { POST as login } from '@/app/api/auth/login/route';

const EMAIL = 'devotp@example.com';
const PASSWORD = 'correct-horse-battery-staple';

async function seedActiveUser() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM otp_codes');
  await db.query('DELETE FROM users');
  await db.query(
    `INSERT INTO users (id, email, name, password_hash, role, status)
     VALUES ('u-devotp', $1, 'Dev OTP', $2, 'viewer', 'active')`,
    [EMAIL, hashPassword(PASSWORD)]
  );
}

function loginRequest() {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
}

describe('POST /api/auth/login — devOtp exposure', () => {
  const SAVED = { ...process.env };

  beforeEach(async () => {
    await seedActiveUser();
    process.env.SESSION_SECRET = 'test-session-secret';
    delete process.env.SMTP_PASS;        // dev mode: no real SMTP
    delete process.env.BTG_DEV_OTP;
  });

  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('does not leak the OTP when BTG_DEV_OTP is not set', async () => {
    const body = await (await login(loginRequest())).json();
    expect(body.devOtp).toBeUndefined();
  });

  it('does not leak the OTP in production even with BTG_DEV_OTP=1', async () => {
    process.env.BTG_DEV_OTP = '1';
    const saved = process.env.NODE_ENV;
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });
    try {
      const body = await (await login(loginRequest())).json();
      expect(body.devOtp).toBeUndefined();
    } finally {
      Object.defineProperty(process.env, 'NODE_ENV', { value: saved, configurable: true });
    }
  });

  it('still surfaces the OTP for local development when explicitly opted in', async () => {
    process.env.BTG_DEV_OTP = '1';
    const body = await (await login(loginRequest())).json();
    expect(body.devOtp).toMatch(/^\d{6}$/);
  });
});
