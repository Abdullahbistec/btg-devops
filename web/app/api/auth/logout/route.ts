import { NextResponse } from 'next/server';
import { sessionCookieOptions } from '@/lib/auth';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Clear both halves of the session. Leaving btg_identity behind is not
  // exploitable — nothing trusts it without a matching btg_session — but a
  // stale identity cookie makes "am I logged out?" needlessly ambiguous.
  res.cookies.set('btg_session', '', sessionCookieOptions(0));
  res.cookies.set('btg_identity', '', sessionCookieOptions(0));
  res.cookies.set('btg_otp_pending', '', sessionCookieOptions(0));
  return res;
}
