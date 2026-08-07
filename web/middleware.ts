import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PREFIXES = ['/login', '/register', '/verify-otp', '/api/auth', '/_next', '/favicon'];

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  const token    = req.cookies.get('btg_session')?.value ?? '';
  const identity = req.cookies.get('btg_identity')?.value ?? '';
  const secret   = process.env.SESSION_SECRET ?? 'btg-devops-default-secret';
  const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
  const adminEmail    = (process.env.ADMIN_EMAIL ?? '').toLowerCase();

  if (!token) return NextResponse.redirect(new URL('/login', req.url));

  // Check against admin (env-var user)
  const adminKey = adminEmail || adminUsername;
  if (await hmac(secret, adminKey) === token) return NextResponse.next();

  // Check against identity cookie (DB user session)
  if (identity && await hmac(secret, identity) === token) return NextResponse.next();

  // Legacy: admin username HMAC (backwards compat)
  if (adminEmail && await hmac(secret, adminUsername) === token) return NextResponse.next();

  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
