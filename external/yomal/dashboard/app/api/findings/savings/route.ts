import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../middleware/auth'
import { savingsController } from '../../controllers/findings'
import { unauthorized } from '../../utils/response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const subscriptionId = req.nextUrl.searchParams.get('subscriptionId') || undefined
  const result = await savingsController(subscriptionId)
  return NextResponse.json(result.data)
}
