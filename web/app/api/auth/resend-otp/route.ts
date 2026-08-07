import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { createOTP } from '@/lib/otp-store';
import { sendOTPEmail } from '@/lib/mailer';

export async function POST(req: NextRequest) {
  const pendingEmail = req.cookies.get('btg_otp_pending')?.value ?? '';
  if (!pendingEmail) {
    return NextResponse.json({ error: 'Session expired. Please sign in again.' }, { status: 401 });
  }

  const otp = createOTP(pendingEmail);
  try {
    await sendOTPEmail(pendingEmail, otp);
  } catch (err) {
    console.error('[auth/resend-otp] sendOTPEmail failed:', err);
    return NextResponse.json({ error: 'Failed to send email. Check SMTP settings.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
