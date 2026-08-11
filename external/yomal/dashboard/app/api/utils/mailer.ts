import nodemailer from 'nodemailer'
import { findRoleSettings } from '../models/notificationSettings'
import { findAllUsers } from '../models/user'

// Node-side counterpart to CLI Engine/internal/mailer/mailer.go — same
// fail-soft philosophy: a missing config or failed send is logged and
// swallowed, never thrown, so a notification problem can't break the MCP
// save_analysis flow it's called from.

// Resolves who should receive a notification: every active user whose role
// has notifications enabled in notification_role_settings. Mirrors the Go
// CLI's db.FindEnabledRoles + db.FindActiveUserEmailsByRoles used for audit-
// failure alerts, so both alert types reach the same audience.
export async function resolveNotificationRecipients(): Promise<string[]> {
  const roleSettings = await findRoleSettings()
  const enabledRoles = new Set<string>(roleSettings.filter(r => r.enabled).map(r => r.role))
  const users = await findAllUsers()
  return users
    .filter(u => u.is_active && enabledRoles.has(u.role))
    .map(u => u.email)
}

// Resolves recipients for an explicit "Share" action — a deliberate,
// one-off send, so it bypasses the notification_role_settings enabled/
// disabled toggle (that toggle governs automatic alerts, not something a
// user is directly asking to send right now). Recipients are the union of
// every active user in the given roles plus every explicitly given userId.
export async function resolveShareRecipients(roles: string[], userIds: string[]): Promise<string[]> {
  const users = await findAllUsers()
  const roleSet = new Set(roles)
  const idSet = new Set(userIds)
  return users
    .filter(u => u.is_active && (roleSet.has(u.role) || idSet.has(u.id)))
    .map(u => u.email)
}

function buildTransport() {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) return null
  return { user, transport: nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user, pass } }) }
}

// Fail-soft — for automatic notifications (audit-complete, audit-failed)
// triggered from inside another flow (the MCP save_analysis tool). A send
// failure here must never surface as an error in that flow; it's logged
// and swallowed.
export async function sendMail(subject: string, html: string, recipients: string[]): Promise<void> {
  const built = buildTransport()
  if (!built) { console.warn('[mailer] skipped: GMAIL_USER/GMAIL_APP_PASSWORD not set'); return }
  if (recipients.length === 0) { console.warn('[mailer] skipped: no notification recipients resolved'); return }

  try {
    await built.transport.sendMail({ from: built.user, to: recipients, subject, html })
  } catch (e) {
    console.warn('[mailer] failed to send:', e instanceof Error ? e.message : e)
  }
}

export interface MailAttachment {
  filename: string
  content: Buffer
}

// Throws instead of swallowing — for the user-initiated "Share" action,
// where silently reporting success on a failed send would be actively
// misleading (the button would say "Sent" while nothing arrived).
export async function sendMailOrThrow(
  subject: string, html: string, recipients: string[], attachments: MailAttachment[] = []
): Promise<void> {
  const built = buildTransport()
  if (!built) throw new Error('Email is not configured on the server (GMAIL_USER/GMAIL_APP_PASSWORD missing)')
  if (recipients.length === 0) throw new Error('No recipients to send to')
  await built.transport.sendMail({ from: built.user, to: recipients, subject, html, attachments })
}
