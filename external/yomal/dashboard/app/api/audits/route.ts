import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../middleware/auth'
import { listAuditsController, createAuditController } from '../controllers/audit'
import { unauthorized, forbidden, ok } from '../utils/response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const result = await listAuditsController()
  return ok(result.data)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const body = await req.json()
  const result = await createAuditController(body)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data, { status: result.status })
}
