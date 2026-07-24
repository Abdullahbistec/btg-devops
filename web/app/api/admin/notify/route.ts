import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail, listUsers } from '@/lib/db';
import nodemailer from 'nodemailer';

function isAdmin(req: NextRequest): boolean {
  const identity = req.cookies.get('btg_identity')?.value ?? '';
  if (!identity) return false;
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (identity === adminEmail) return true;
  try {
    const user = getUserByEmail(identity);
    return user?.role === 'admin' && user?.status === 'active';
  } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const { subject, message, recipients } = body as {
    subject?: string;
    message?: string;
    recipients?: 'all' | 'active' | string[];
  };

  if (!subject || !message) {
    return NextResponse.json({ error: 'Subject and message are required' }, { status: 400 });
  }

  // Resolve recipient list
  let emails: string[] = [];
  if (Array.isArray(recipients)) {
    emails = recipients;
  } else {
    const status = recipients === 'active' ? 'active' : undefined;
    emails = listUsers(status).map(u => u.email);
  }

  if (emails.length === 0) {
    return NextResponse.json({ error: 'No recipients found' }, { status: 400 });
  }

  const devMode = !process.env.SMTP_PASS || process.env.SMTP_PASS === 'your-email-password-here';

  if (devMode) {
    console.log('\n[Admin Notify] DEV MODE — email not sent');
    console.log('Subject:', subject);
    console.log('To:', emails.join(', '));
    console.log('Message:', message);
    return NextResponse.json({ ok: true, devMode: true, sent: emails.length });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });

  const from = process.env.SMTP_FROM ?? `BTG DevOps <${process.env.SMTP_USER}>`;
  const html = `
    <div style="font-family:'Segoe UI',sans-serif;background:#050818;padding:32px;border-radius:12px;max-width:520px;border:1px solid rgba(0,194,255,0.2);">
      <div style="background:linear-gradient(135deg,#FFA502,#FF4757);padding:18px 24px;border-radius:8px 8px 0 0;margin:-32px -32px 24px;">
        <span style="font-size:16px;font-weight:800;color:#fff;">BTG DevOps — Security Console</span>
      </div>
      <div style="font-size:14px;color:#C8D4F0;line-height:1.75;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);font-size:10px;color:#2A3560;">
        BTG DevOps Security Console · Internal Use Only
      </div>
    </div>
  `;

  let sent = 0;
  const errors: string[] = [];

  for (const to of emails) {
    try {
      await transporter.sendMail({ from, to, subject, html, text: message });
      sent++;
    } catch (e) {
      errors.push(`${to}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({ ok: true, sent, errors, total: emails.length });
}
