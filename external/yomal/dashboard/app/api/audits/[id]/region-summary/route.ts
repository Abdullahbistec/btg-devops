import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../../middleware/auth'
import { getRegionSummaryController } from '../../../controllers/audit'
import { unauthorized } from '../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id } = await params
  const result = await getRegionSummaryController(id)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
