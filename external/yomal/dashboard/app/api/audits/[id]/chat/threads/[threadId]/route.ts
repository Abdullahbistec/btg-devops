import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../../../middleware/auth'
import { listChatController, deleteThreadController } from '../../../../../controllers/chat'
import { unauthorized, forbidden } from '../../../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; threadId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id, threadId } = await params
  const result = await listChatController(id, threadId)
  return NextResponse.json(result.data)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; threadId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { id, threadId } = await params
  const result = await deleteThreadController(id, threadId)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
