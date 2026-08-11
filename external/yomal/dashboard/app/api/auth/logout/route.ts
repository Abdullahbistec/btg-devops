import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../middleware/auth'
import { logoutController } from '../../controllers/auth'
import { unauthorized } from '../../utils/response'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const result = await logoutController(req)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
