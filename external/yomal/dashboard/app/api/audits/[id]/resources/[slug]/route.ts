import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../../../middleware/auth'
import { getAuditResourceController } from '../../../../controllers/resource'
import { unauthorized } from '../../../../utils/response'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; slug: string }> }
) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id, slug } = await params
  const result = await getAuditResourceController(id, slug)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
