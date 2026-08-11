import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../middleware/auth'
import { unauthorized, forbidden, badRequest, serverError } from '../../../utils/response'
import { buildScopeShareData } from '../../../utils/auditSummaryEmail'
import { sendMailOrThrow, resolveShareRecipients, type MailAttachment } from '../../../utils/mailer'
import { buildPDFDoc, buildExcelWorkbook, filenameBase } from '../../../../lib/reportBuilders'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const scope = typeof body.scope === 'string' && body.scope ? body.scope : 'all'
  const roles: string[] = Array.isArray(body.roles) ? body.roles.filter((r: unknown) => typeof r === 'string') : []
  const userIds: string[] = Array.isArray(body.userIds) ? body.userIds.filter((u: unknown) => typeof u === 'string') : []

  // Only admins may target specific individual users — analysts can only
  // share to roles, matching the read access /api/users already enforces
  // (that endpoint is admin-only, so an analyst has no way to see user IDs
  // to pick from in the first place).
  if (userIds.length > 0 && !requireRole(auth, ['admin'])) return forbidden()

  if (roles.length === 0 && userIds.length === 0) {
    return badRequest('select at least one role or user to share with')
  }

  const share = await buildScopeShareData(id, scope)
  if (!share) return NextResponse.json({ error: 'audit not found' }, { status: 404 })

  const recipients = await resolveShareRecipients(roles, userIds)
  if (recipients.length === 0) {
    return badRequest('no active users matched the selected roles/users')
  }

  try {
    const base = filenameBase(share.reportMeta)
    const pdfBuffer = Buffer.from(buildPDFDoc(share.findings, share.reportMeta).output('arraybuffer'))
    const excelWorkbook = await buildExcelWorkbook(share.findings, share.reportMeta)
    const excelBuffer = Buffer.from(await excelWorkbook.xlsx.writeBuffer())

    const attachments: MailAttachment[] = [
      { filename: `${base}.pdf`, content: pdfBuffer },
      { filename: `${base}.xlsx`, content: excelBuffer },
    ]

    await sendMailOrThrow(share.subject, share.html, recipients, attachments)
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'failed to send email')
  }
  return NextResponse.json({ sent: true, recipientCount: recipients.length })
}
