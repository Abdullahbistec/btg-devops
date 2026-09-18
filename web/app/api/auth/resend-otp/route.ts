import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { createOTP } from '@/lib/otp-store';
import { sendOTPEmail } from '@/lib/mailer';
import { consumeRateLimit, rateLimited } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const pendingEmail = req.cookies.get('btg_otp_pending')?.value ?? '';
  if (!pendingEmail) {
    return NextResponse.json({ error: 'Session expired. Please sign in again.' }, { status: 401 });
  }

  // Each resend sends an email, so this is both a brute-force control and a
  // spend/abuse control on the mail provider. The 60-second cooldown is a
  // second bucket with a limit of one — cheaper than tracking a timestamp.
  const cooldown = await consumeRateLimit(`resend-cooldown:${pendingEmail.toLowerCase()}`, 1, 60);
  if (!cooldown.allowed) return rateLimited(cooldown);

  const window = await consumeRateLimit(`resend:email:${pendingEmail.toLowerCase()}`, 3, 900);
  if (!window.allowed) return rateLimited(window);

  const otp = await createOTP(pendingEmail);
  try {
    await sendOTPEmail(pendingEmail, otp);
  } catch (err) {
    console.error('[auth/resend-otp] sendOTPEmail failed:', err);
    return NextResponse.json({ error: 'Failed to send email. Check SMTP settings.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
