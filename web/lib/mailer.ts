import nodemailer from 'nodemailer';

const DEV_MODE = !process.env.SMTP_PASS || process.env.SMTP_PASS === 'your-email-password-here';

function createTransport() {
  const port = Number(process.env.SMTP_PORT ?? 587);
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST ?? 'smtp.resend.com',
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: false },
  });
}

export async function sendOTPEmail(to: string, otp: string): Promise<void> {
  // Dev fallback: log to console if SMTP not configured
  if (DEV_MODE) {
    console.log('\n========================================');
    console.log('  BTG DevOps — OTP Code (dev mode)');
    console.log(`  Email : ${to}`);
    console.log(`  Code  : ${otp}`);
    console.log('  (Configure SMTP_PASS in .env.local to send real emails)');
    console.log('========================================\n');
    return;
  }

  const from = process.env.SMTP_FROM ?? `BTG DevOps <${process.env.SMTP_USER}>`;
  const transporter = createTransport();
  const html = buildOTPEmail(otp);

  await transporter.sendMail({
    from, to,
    subject: `${otp} — BTG DevOps verification code`,
    html,
    text: `Your BTG DevOps verification code is: ${otp}\n\nExpires in 5 minutes. Do not share this code.`,
  });
}

export async function sendScheduleFailureEmail(to: string, auditName: string, errorMessage: string): Promise<void> {
  if (DEV_MODE) {
    console.log(`\n[BTG DevOps] Scheduled audit FAILED: ${auditName} — ${errorMessage}\n`);
    return;
  }
  const from = process.env.SMTP_FROM ?? `BTG DevOps <${process.env.SMTP_USER}>`;
  const transporter = createTransport();
  await transporter.sendMail({
    from, to,
    subject: `[BTG DevOps] Scheduled audit failed — ${auditName}`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;background:#050818;padding:32px;border-radius:12px;max-width:500px;border:1px solid rgba(255,71,87,0.3);">
        <h2 style="color:#FF4757;margin:0 0 8px;">Scheduled Audit Failed</h2>
        <p style="color:#5B6FA8;margin:0 0 16px;">${auditName}</p>
        <div style="background:rgba(255,71,87,0.08);border:1px solid rgba(255,71,87,0.25);border-radius:8px;padding:12px 16px;font-family:monospace;font-size:12px;color:#E8ECF8;word-break:break-word;">
          ${errorMessage}
        </div>
        <p style="margin:20px 0 0;font-size:11px;color:#2A3560;">Check the Audits page in the BTG DevOps Security Console for details.</p>
      </div>
    `,
    text: `Scheduled audit "${auditName}" failed:\n${errorMessage}`,
  });
}

export async function sendRegistrationNotification(adminEmail: string, newUserEmail: string, newUserName: string): Promise<void> {
  if (DEV_MODE) {
    console.log(`\n[BTG DevOps] New access request: ${newUserName} <${newUserEmail}> — approve at Settings → User Management\n`);
    return;
  }
  const from = process.env.SMTP_FROM ?? `BTG DevOps <${process.env.SMTP_USER}>`;
  const transporter = createTransport();
  await transporter.sendMail({
    from, to: adminEmail,
    subject: `[BTG DevOps] Access request — ${newUserName}`,
    text: `${newUserName} (${newUserEmail}) has requested access to the BTG DevOps Security Console.\n\nLog in to Settings → User Management to approve or reject.`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;background:#050818;padding:32px;border-radius:12px;max-width:500px;border:1px solid rgba(0,194,255,0.2);">
        <h2 style="color:#00C2FF;margin:0 0 6px;">New Access Request</h2>
        <p style="color:#5B6FA8;margin:0 0 20px;font-size:13px;">Someone has requested access to BTG DevOps Security Console</p>
        <div style="background:rgba(0,194,255,0.06);border:1px solid rgba(0,194,255,0.2);border-radius:8px;padding:16px 18px;margin-bottom:20px;">
          <div style="font-size:15px;font-weight:700;color:#E8ECF8;">${newUserName}</div>
          <div style="font-size:12px;color:#5B6FA8;margin-top:3px;">${newUserEmail}</div>
        </div>
        <p style="font-size:12px;color:#5B6FA8;margin:0 0 20px;">Log in and go to <strong style="color:#E8ECF8;">Settings → User Management</strong> to approve or reject this request.</p>
        <p style="margin:20px 0 0;font-size:11px;color:#2A3560;">BTG DevOps Security Console · Internal Use Only</p>
      </div>
    `,
  });
}

/** Configured notification recipients: NOTIFICATION_EMAILS (comma-separated) if
 * set, otherwise falls back to the single ADMIN_EMAIL as before. */
export function getNotificationRecipients(): string {
  const list = process.env.NOTIFICATION_EMAILS?.trim();
  if (list) return list;
  return process.env.ADMIN_EMAIL ?? '';
}

export async function sendAuditSummaryEmail(
  to: string,
  auditName: string,
  stats: { total: number; critical: number; warning: number; info: number },
  auditId?: string
): Promise<void> {
  const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const link = auditId ? `${appUrl}/dashboard?audit_id=${auditId}` : `${appUrl}/dashboard`;

  if (DEV_MODE) {
    console.log(`\n[BTG DevOps] Audit complete: ${auditName} — ${stats.critical} crit, ${stats.warning} warn, ${stats.info} info, ${stats.total} total — ${link}\n`);
    return;
  }
  const from = process.env.SMTP_FROM ?? `BTG DevOps <${process.env.SMTP_USER}>`;
  const transporter = createTransport();
  await transporter.sendMail({
    from, to,
    subject: `[BTG DevOps] Audit complete — ${stats.critical} critical finding${stats.critical !== 1 ? 's' : ''}`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;background:#050818;padding:32px;border-radius:12px;max-width:500px;border:1px solid rgba(0,194,255,0.2);">
        <h2 style="color:#00C2FF;margin:0 0 8px;">Audit Complete</h2>
        <p style="color:#5B6FA8;margin:0 0 20px;">${auditName}</p>
        <table width="100%" style="border-collapse:collapse;">
          ${[['Critical','#FF4757',stats.critical],['Warning','#FFA502',stats.warning],['Info','#54A0FF',stats.info],['Total','#00C2FF',stats.total]].map(([l,c,v]) =>
            `<tr><td style="padding:6px 0;color:#5B6FA8;font-size:13px;">${l}</td><td style="padding:6px 0;color:${c};font-weight:700;font-size:18px;">${v}</td></tr>`
          ).join('')}
        </table>
        <a href="${link}" style="display:inline-block;margin-top:20px;padding:10px 20px;background:#00C2FF;color:#04141a;font-weight:700;text-decoration:none;border-radius:6px;font-size:13px;">View this audit →</a>
        <p style="margin:16px 0 0;font-size:11px;color:#2A3560;">Or log in to the BTG DevOps Security Console directly.</p>
      </div>
    `,
    text: `Audit "${auditName}" complete.\nCritical: ${stats.critical}\nWarning: ${stats.warning}\nInfo: ${stats.info}\nTotal: ${stats.total}\n\nView it here: ${link}`,
  });
}

function buildOTPEmail(otp: string) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#050818;font-family:'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="420" cellpadding="0" cellspacing="0"
        style="background:rgba(14,19,55,0.97);border:1px solid rgba(0,194,255,0.2);border-radius:12px;overflow:hidden;">
        <tr><td style="background:linear-gradient(135deg,#00C2FF,#7B5EA7);padding:24px 32px;">
          <span style="font-size:18px;font-weight:800;color:#fff;">BTG DevOps — Security Console</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#E8ECF8;">Your verification code</p>
          <p style="margin:0 0 28px;font-size:13px;color:#5B6FA8;line-height:1.6;">
            Enter this code to complete sign-in. Expires in <strong style="color:#E8ECF8;">5 minutes</strong>.
          </p>
          <div style="text-align:center;margin:0 0 28px;">
            <div style="display:inline-block;background:rgba(0,194,255,0.08);border:1px solid rgba(0,194,255,0.3);border-radius:10px;padding:18px 40px;">
              <span style="font-size:38px;font-weight:900;letter-spacing:12px;color:#00C2FF;font-family:monospace;">${otp}</span>
            </div>
          </div>
          <p style="margin:0;font-size:11px;color:#2A3560;">Do not share this code with anyone.</p>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid rgba(0,194,255,0.1);">
          <p style="margin:0;font-size:10px;color:#2A3560;text-align:center;">BTG DevOps Security Console · Internal Use Only</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
