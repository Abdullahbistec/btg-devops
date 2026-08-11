import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../middleware/auth'
import { listDataGapsController, markDataGapFixedController } from '../controllers/dataGaps'
import { unauthorized, forbidden, ok } from '../utils/response'

// Same access as running Analyze itself (admin/analyst) — this exposes what
// the analysis agent couldn't verify, which is an internal data-collection
// detail, not a finding a viewer needs.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const result = await listDataGapsController()
  return ok(result.data)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const body = await req.json()
  const result = await markDataGapFixedController(auth.user_id, body)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data, { status: result.status })
}
