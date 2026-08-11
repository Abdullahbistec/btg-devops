import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../middleware/auth'
import { createAnalysisRequestController } from '../../../controllers/audit'
import { unauthorized, forbidden } from '../../../utils/response'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const scope = typeof body.scope === 'string' && body.scope ? body.scope : 'all'

  const result = await createAnalysisRequestController(id, scope)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data, { status: result.status })
}
