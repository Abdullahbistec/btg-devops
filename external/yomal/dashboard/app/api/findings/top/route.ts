import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../middleware/auth'
import { topFindingsController } from '../../controllers/findings'
import { unauthorized } from '../../utils/response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const limit = Math.min(20, Number(req.nextUrl.searchParams.get('limit')) || 8)
  const result = await topFindingsController(limit)
  return NextResponse.json(result.data)
}
