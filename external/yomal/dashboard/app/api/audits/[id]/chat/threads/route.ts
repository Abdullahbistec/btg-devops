import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../../middleware/auth'
import { listThreadsController, createThreadController } from '../../../../controllers/chat'
import { unauthorized, forbidden } from '../../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id } = await params
  const result = await listThreadsController(id)
  return NextResponse.json(result.data)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { id } = await params
  const result = await createThreadController(id, auth)
  return NextResponse.json(result.data, { status: result.status })
}
