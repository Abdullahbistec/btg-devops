import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail } from '@/lib/db';
import { getVerifiedIdentity } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const identity = getVerifiedIdentity(req);
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  const adminName = process.env.ADMIN_USERNAME ?? 'admin';

  if (!identity) {
    // No cookie, or a cookie that fails HMAC verification, is not a session —
    // this used to fall back to reporting the caller as the admin.
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  if (identity === adminEmail) {
    return NextResponse.json({ email: adminEmail, name: adminName, role: 'admin' });
  }

  const user = await getUserByEmail(identity);
  if (!user || user.status !== 'active') {
    return NextResponse.json({ email: identity, name: identity.split('@')[0], role: 'viewer' });
  }

  return NextResponse.json({ email: user.email, name: user.name || user.email.split('@')[0], role: user.role });
}
