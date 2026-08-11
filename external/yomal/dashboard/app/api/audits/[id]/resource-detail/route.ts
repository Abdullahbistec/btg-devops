import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../../middleware/auth'
import { getResourceDetailController } from '../../../controllers/audit'
import { unauthorized } from '../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id } = await params
  const resourceId = req.nextUrl.searchParams.get('resourceId')
  if (!resourceId) return NextResponse.json({ error: 'resourceId query param required' }, { status: 400 })

  const result = await getResourceDetailController(id, resourceId)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
