import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../middleware/auth'
import { severityCountsController } from '../../controllers/findings'
import { unauthorized } from '../../utils/response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const idsParam = req.nextUrl.searchParams.get('auditIds') || ''
  const auditIds = idsParam.split(',').map(s => s.trim()).filter(Boolean)
  if (auditIds.length === 0) return NextResponse.json({})

  const result = await severityCountsController(auditIds)
  return NextResponse.json(result.data)
}
