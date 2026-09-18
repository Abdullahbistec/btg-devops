import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { requireSessionSecret } from './auth';
import { POST as login } from '@/app/api/auth/login/route';

describe('requireSessionSecret', () => {
  const ORIGINAL = process.env.SESSION_SECRET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ORIGINAL;
  });

  it('returns the configured secret', () => {
    process.env.SESSION_SECRET = 'a-real-secret';
    expect(requireSessionSecret()).toBe('a-real-secret');
  });

  it('throws rather than falling back to a hardcoded default', () => {
    delete process.env.SESSION_SECRET;
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it('treats an empty string as unset', () => {
    process.env.SESSION_SECRET = '';
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET/);
  });
});

describe('POST /api/auth/login — admin bypass with no SESSION_SECRET', () => {
  const ORIGINAL_SECRET = process.env.SESSION_SECRET;
  const ORIGINAL_EMAIL  = process.env.ADMIN_EMAIL;
  const ORIGINAL_PASS   = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_EMAIL === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = ORIGINAL_EMAIL;
    if (ORIGINAL_PASS === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = ORIGINAL_PASS;
  });

  it('refuses to authenticate rather than signing with a public default', async () => {
    const res = await login(new NextRequest('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse-battery-staple' }),
    }));

    expect(res.status).toBe(500);
    // And crucially: no session cookie was handed out.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('btg_session');
  });
});
