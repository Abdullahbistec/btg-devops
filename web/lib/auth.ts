import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'crypto';
import type { NextRequest } from 'next/server';
import { getUserByEmail } from '@/lib/db';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(':');
    const buf = scryptSync(password, salt, 64);
    return timingSafeEqual(buf, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

export function makeSessionToken(secret: string, email: string): string {
  return createHmac('sha256', secret).update(email).digest('hex');
}

/** The secret used to sign sessions. Throws rather than returning a default:
 * the old `?? 'btg-devops-default-secret'` fallback is committed to this
 * repository, so a deployment that forgot the variable was handing out
 * sessions anyone could forge. A loud 500 at login is the correct failure. */
export function requireSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set — refusing to issue a session');
  }
  return secret;
}

/** Shared options for every auth cookie this app sets.
 *
 * `secure` is conditional rather than always true because local development
 * serves plain http://localhost, where a Secure cookie is silently dropped
 * and login appears to succeed while no session is ever stored. A function
 * rather than a constant so NODE_ENV is read per call. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeSeconds,
    path: '/' as const,
  };
}

/** The plaintext `btg_identity` cookie is not proof of anything by itself —
 * anyone can set it on their own request. `btg_session` is an
 * HMAC(SESSION_SECRET, identity) issued at login (see verify-otp/route.ts);
 * only a match here means the caller actually holds a session this server
 * issued. Returns '' (never throws) on any missing/mismatched piece,
 * including an unset SESSION_SECRET, so a misconfigured deployment fails
 * closed instead of trusting the cookie alone. */
export function getVerifiedIdentity(req: NextRequest): string {
  const identity = (req.cookies.get('btg_identity')?.value ?? '').toLowerCase();
  const session = req.cookies.get('btg_session')?.value ?? '';
  if (!identity || !session) return '';
  const secret = process.env.SESSION_SECRET;
  if (!secret) return '';
  const expected = makeSessionToken(secret, identity);
  const a = Buffer.from(session);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return '';
  return identity;
}

async function resolveIdentity(req: NextRequest): Promise<{ email: string; role: 'admin' | 'viewer' } | null> {
  const identity = getVerifiedIdentity(req);
  if (!identity) return null;
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (adminEmail && identity === adminEmail) return { email: identity, role: 'admin' };
  const user = await getUserByEmail(identity);
  if (!user || user.status !== 'active') return null;
  return { email: identity, role: user.role === 'admin' ? 'admin' : 'viewer' };
}

/** Defaults to 'viewer' — including for a request with no session at all —
 * so callers must treat 'viewer' as "not proven to be admin" rather than
 * "logged in as a non-admin". Use isAuthenticatedRequest() where the
 * distinction between "no session" and "a real viewer session" matters. */
export async function getRequestRole(req: NextRequest): Promise<'admin' | 'viewer'> {
  return (await resolveIdentity(req))?.role ?? 'viewer';
}

export async function isAdminRequest(req: NextRequest): Promise<boolean> {
  return (await getRequestRole(req)) === 'admin';
}

/** True only for a verified session belonging to an active user (or the
 * configured ADMIN_EMAIL) — admin or viewer role either one. Use this to
 * guard routes that any signed-in user may reach; use isAdminRequest for
 * admin-only routes. */
export async function isAuthenticatedRequest(req: NextRequest): Promise<boolean> {
  return (await resolveIdentity(req)) !== null;
}

/**
 * Guards the internal /api/internal/* routes the MCP server (cmd/mcp.go
 * --http) calls on this dashboard's behalf. This is a separate secret from
 * user sessions (cookie/JWT) — it authenticates a service (the MCP server),
 * not a person, and is reachable from wherever that server runs rather than
 * only from a logged-in browser.
 */
export function isInternalServiceRequest(req: NextRequest): boolean {
  const expected = process.env.MCP_INTERNAL_TOKEN ?? '';
  if (!expected) return false; // unset = feature disabled, never authorize
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
