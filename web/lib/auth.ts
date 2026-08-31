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

export async function getRequestRole(req: NextRequest): Promise<'admin' | 'viewer'> {
  const identity = (req.cookies.get('btg_identity')?.value ?? '').toLowerCase();
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (!identity || (adminEmail && identity === adminEmail)) return 'admin';
  const user = await getUserByEmail(identity);
  if (!user || user.status !== 'active') return 'viewer';
  return user.role === 'admin' ? 'admin' : 'viewer';
}

export async function isAdminRequest(req: NextRequest): Promise<boolean> {
  return (await getRequestRole(req)) === 'admin';
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
