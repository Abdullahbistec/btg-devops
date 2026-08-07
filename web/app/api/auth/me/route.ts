import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail } from '@/lib/db';

export async function GET(req: NextRequest) {
  const identity = req.cookies.get('btg_identity')?.value ?? '';
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  const adminName = process.env.ADMIN_USERNAME ?? 'admin';

  if (!identity) {
    return NextResponse.json({ email: adminEmail, name: adminName, role: 'admin' });
  }

  if (identity === adminEmail) {
    return NextResponse.json({ email: adminEmail, name: adminName, role: 'admin' });
  }

  const user = getUserByEmail(identity);
  if (!user || user.status !== 'active') {
    return NextResponse.json({ email: identity, name: identity.split('@')[0], role: 'viewer' });
  }

  return NextResponse.json({ email: user.email, name: user.name || user.email.split('@')[0], role: user.role });
}
