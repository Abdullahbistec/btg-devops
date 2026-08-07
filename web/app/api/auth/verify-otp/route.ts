import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { verifyOTP } from '@/lib/otp-store';

function makeSessionToken(secret: string, identity: string) {
  return createHmac('sha256', secret).update(identity).digest('hex');
}

export async function POST(req: NextRequest) {
  const pendingEmail = req.cookies.get('btg_otp_pending')?.value ?? '';
  if (!pendingEmail) {
    return NextResponse.json({ error: 'Session expired. Please sign in again.' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { otp } = body as { otp?: string };

  if (!otp || !/^\d{6}$/.test(otp)) {
    return NextResponse.json({ error: 'Enter a valid 6-digit code' }, { status: 400 });
  }

  const result = verifyOTP(pendingEmail, otp);

  if (result === 'expired') {
    return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 401 });
  }
  if (result === 'locked') {
    return NextResponse.json({ error: 'Too many attempts. Please sign in again.' }, { status: 429 });
  }
  if (result === 'invalid') {
    return NextResponse.json({ error: 'Incorrect code. Try again.' }, { status: 401 });
  }

  // OTP valid — issue session tied to this user's email
  const secret = process.env.SESSION_SECRET ?? 'btg-devops-default-secret';
  const token = makeSessionToken(secret, pendingEmail);

  const res = NextResponse.json({ ok: true });
  res.cookies.set('btg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
  res.cookies.set('btg_identity', pendingEmail, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
  res.cookies.set('btg_otp_pending', '', { maxAge: 0, path: '/' });
  return res;
}
