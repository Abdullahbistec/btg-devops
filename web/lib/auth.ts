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

export function getRequestRole(req: NextRequest): 'admin' | 'viewer' {
  const identity = (req.cookies.get('btg_identity')?.value ?? '').toLowerCase();
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (!identity || (adminEmail && identity === adminEmail)) return 'admin';
  const user = getUserByEmail(identity);
  if (!user || user.status !== 'active') return 'viewer';
  return user.role === 'admin' ? 'admin' : 'viewer';
}

export function isAdminRequest(req: NextRequest): boolean {
  return getRequestRole(req) === 'admin';
}
