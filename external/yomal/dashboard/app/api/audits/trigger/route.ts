import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../middleware/auth'
import { triggerAuditController } from '../../controllers/audit'
import { unauthorized, forbidden } from '../../utils/response'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const result = await triggerAuditController()
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data, { status: result.status })
}
