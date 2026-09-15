import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { getVerifiedIdentity, getRequestRole, isAuthenticatedRequest, makeSessionToken } from './auth';

const SECRET = 'test-session-secret';

function requestWith(cookie: string): NextRequest {
  return new NextRequest('http://localhost/api/whatever', {
    headers: cookie ? { cookie } : {},
  });
}

function sessionCookie(email: string, secret = SECRET): string {
  return `btg_identity=${email}; btg_session=${makeSessionToken(secret, email)}`;
}

describe('getVerifiedIdentity', () => {
  const ORIGINAL_SECRET = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ORIGINAL_SECRET;
  });

  it('returns empty when there is no btg_identity cookie at all', () => {
    expect(getVerifiedIdentity(requestWith(''))).toBe('');
  });

  it('returns empty when the identity cookie is present but the session cookie is missing', () => {
    // The exact C2 attack: an attacker sets only btg_identity, forging identity
    // without ever holding a valid HMAC.
    expect(getVerifiedIdentity(requestWith('btg_identity=admin@example.com'))).toBe('');
  });

  it('returns empty when the session does not match the HMAC of the identity', () => {
    expect(getVerifiedIdentity(requestWith('btg_identity=admin@example.com; btg_session=deadbeef'))).toBe('');
  });

  it('returns the identity as stored in the cookie, lowercased for comparison', () => {
    // Real issuers (login/verify-otp) always sign over the already-lowercased
    // email, so this mirrors that rather than asserting case-insensitive HMAC
    // matching, which the implementation deliberately does not do.
    expect(getVerifiedIdentity(requestWith(sessionCookie('admin@example.com')))).toBe('admin@example.com');
  });

  it('returns empty when SESSION_SECRET is unset, even with an otherwise-valid-looking pair', () => {
    const cookie = sessionCookie('admin@example.com');
    delete process.env.SESSION_SECRET;
    expect(getVerifiedIdentity(requestWith(cookie))).toBe('');
  });
});

describe('getRequestRole / isAuthenticatedRequest', () => {
  const ORIGINAL_SECRET = process.env.SESSION_SECRET;
  const ORIGINAL_ADMIN = process.env.ADMIN_EMAIL;

  beforeEach(async () => {
    process.env.SESSION_SECRET = SECRET;
    process.env.ADMIN_EMAIL = 'admin@example.com';

    const db = await getDB();
    const { rows } = await db.query('SELECT current_database() as name');
    if (!String(rows[0].name).endsWith('_test')) {
      throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
    }
    await db.query('DELETE FROM users');
    await db.query(
      `INSERT INTO users (id, email, name, password_hash, role, status) VALUES
       ('u-viewer',   'viewer@example.com',   'Viewer',   'x', 'viewer', 'active'),
       ('u-adminrow', 'adminrow@example.com', 'AdminRow', 'x', 'admin',  'active'),
       ('u-pending',  'pending@example.com',  'Pending',  'x', 'admin',  'pending')`
    );
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_ADMIN === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN;
  });

  it('treats a request with no cookies at all as viewer, never admin', async () => {
    // The C1 regression: !identity used to short-circuit straight to 'admin'.
    expect(await getRequestRole(requestWith(''))).toBe('viewer');
  });

  it('treats a request with no cookies at all as unauthenticated', async () => {
    expect(await isAuthenticatedRequest(requestWith(''))).toBe(false);
  });

  it('does not grant admin from a forged plaintext identity cookie with no valid session', async () => {
    // The C2 regression: btg_session was never checked.
    expect(await getRequestRole(requestWith('btg_identity=admin@example.com'))).toBe('viewer');
    expect(await isAuthenticatedRequest(requestWith('btg_identity=admin@example.com'))).toBe(false);
  });

  it('grants admin for a verified session matching ADMIN_EMAIL', async () => {
    const req = requestWith(sessionCookie('admin@example.com'));
    expect(await getRequestRole(req)).toBe('admin');
    expect(await isAuthenticatedRequest(req)).toBe(true);
  });

  it('grants admin for a verified session matching an active admin-role user', async () => {
    const req = requestWith(sessionCookie('adminrow@example.com'));
    expect(await getRequestRole(req)).toBe('admin');
  });

  it('grants viewer for a verified session matching an active viewer-role user', async () => {
    const req = requestWith(sessionCookie('viewer@example.com'));
    expect(await getRequestRole(req)).toBe('viewer');
    expect(await isAuthenticatedRequest(req)).toBe(true);
  });

  it('treats a verified session for a pending (not-yet-approved) user as unauthenticated', async () => {
    const req = requestWith(sessionCookie('pending@example.com'));
    expect(await getRequestRole(req)).toBe('viewer');
    expect(await isAuthenticatedRequest(req)).toBe(false);
  });

  it('treats a verified session for an unknown email as unauthenticated', async () => {
    const req = requestWith(sessionCookie('nobody@example.com'));
    expect(await getRequestRole(req)).toBe('viewer');
    expect(await isAuthenticatedRequest(req)).toBe(false);
  });
});
