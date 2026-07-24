import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { createOTP } from '@/lib/otp-store';
import { sendOTPEmail } from '@/lib/mailer';
import { getUserByEmail } from '@/lib/db';
import { verifyPassword } from '@/lib/auth';

function makeSessionToken(secret: string, username: string) {
  return createHmac('sha256', secret).update(username).digest('hex');
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { email, password } = body as { email?: string; password?: string };

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  const normalEmail = email.trim().toLowerCase();
  const adminEmail  = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  const adminPass   = process.env.ADMIN_PASSWORD ?? '';

  // 1. Check if this is the env-var admin → auto-approve (skip OTP)
  if (normalEmail === adminEmail && adminEmail !== '') {
    if (password !== adminPass) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }
    // Admin bypasses OTP — set session directly
    const secret   = process.env.SESSION_SECRET ?? 'btg-devops-default-secret';
    const username = process.env.ADMIN_USERNAME ?? 'admin';
    const token    = makeSessionToken(secret, username);
    const res = NextResponse.json({ ok: true, skipOtp: true });
    res.cookies.set('btg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
    res.cookies.set('btg_identity', normalEmail, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
    return res;
  }

  // 2. Check DB users
  const dbUser = getUserByEmail(normalEmail);
  if (!dbUser) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }
  if (dbUser.status === 'pending') {
    return NextResponse.json({ error: 'Your access request is pending admin approval.' }, { status: 403 });
  }
  if (dbUser.status === 'rejected') {
    return NextResponse.json({ error: 'Your access request was declined.' }, { status: 403 });
  }
  if (dbUser.status === 'inactive') {
    return NextResponse.json({ error: 'Your account has been deactivated. Contact your administrator.' }, { status: 403 });
  }
  if (!verifyPassword(password, dbUser.password_hash)) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  // 3. Generate & send OTP to user's own email
  const devMode = !process.env.SMTP_PASS || process.env.SMTP_PASS === 'your-email-password-here';
  const otp = createOTP(normalEmail);
  try {
    await sendOTPEmail(normalEmail, otp);
  } catch (err) {
    console.error('[auth/login] sendOTPEmail failed:', err);
    return NextResponse.json({ error: 'Failed to send verification email. Check SMTP settings.' }, { status: 502 });
  }

  // In dev mode (no real SMTP) surface the OTP in the response so the UI can show it
  const payload: Record<string, unknown> = { ok: true, skipOtp: false };
  if (devMode) payload.devOtp = otp;

  const res = NextResponse.json(payload);
  res.cookies.set('btg_otp_pending', normalEmail, {
    httpOnly: true, sameSite: 'lax', maxAge: 60 * 10, path: '/',
  });
  return res;
}
