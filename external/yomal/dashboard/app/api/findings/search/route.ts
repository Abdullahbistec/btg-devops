import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../middleware/auth'
import { searchFindingsController } from '../../controllers/findings'
import { unauthorized } from '../../utils/response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const q = req.nextUrl.searchParams.get('q') || ''
  const limit = Math.min(10, Number(req.nextUrl.searchParams.get('limit')) || 8)
  const result = await searchFindingsController(q, limit)
  return NextResponse.json(result.data)
}
