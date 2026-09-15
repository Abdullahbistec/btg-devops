import { NextResponse } from 'next/server';
import { createOTP } from '@/lib/otp-store';
import { sendOTPEmail } from '@/lib/mailer';
import { getUserByEmail } from '@/lib/db';
import { verifyPassword, makeSessionToken, requireSessionSecret } from '@/lib/auth';

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
    // Admin bypasses OTP — set session directly. Signed over the identity
    // email (normalEmail), matching every other issuer (verify-otp) and what
    // getVerifiedIdentity() re-derives from the btg_identity cookie below —
    // it used to sign over the ADMIN_USERNAME string instead, which never
    // matched the email-keyed verification a route-level check would do.
    let token: string;
    try {
      token = makeSessionToken(requireSessionSecret(), normalEmail);
    } catch (e) {
      console.error('[auth/login]', e);
      return NextResponse.json({ error: 'Server is not configured for sign-in.' }, { status: 500 });
    }
    const res = NextResponse.json({ ok: true, skipOtp: true });
    res.cookies.set('btg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
    res.cookies.set('btg_identity', normalEmail, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
    return res;
  }

  // 2. Check DB users
  const dbUser = await getUserByEmail(normalEmail);
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
  const otp = await createOTP(normalEmail);
  try {
    await sendOTPEmail(normalEmail, otp);
  } catch (err) {
    console.error('[auth/login] sendOTPEmail failed:', err);
    return NextResponse.json({ error: 'Failed to send verification email. Check SMTP settings.' }, { status: 502 });
  }

  // Surfacing the OTP in the response bypasses MFA for anyone who can see
  // that response — and web/app/login/page.tsx forwards it as a query
  // parameter, so it reaches browser history, Referer headers and access
  // logs too. "SMTP is unconfigured" is a property of the deployment, not
  // of the environment, so it is not a safe gate on its own: a production
  // instance with broken SMTP credentials would hand out the code. Both an
  // explicit opt-in and a non-production build are now required.
  const allowDevOtp = process.env.NODE_ENV !== 'production' && process.env.BTG_DEV_OTP === '1';
  const payload: Record<string, unknown> = { ok: true, skipOtp: false };
  if (devMode && allowDevOtp) payload.devOtp = otp;

  const res = NextResponse.json(payload);
  res.cookies.set('btg_otp_pending', normalEmail, {
    httpOnly: true, sameSite: 'lax', maxAge: 60 * 10, path: '/',
  });
  return res;
}
