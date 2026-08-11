import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../../middleware/auth'
import { getChatMessageController, updateChatController, deleteChatController } from '../../../../controllers/chat'
import { unauthorized, forbidden } from '../../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { messageId } = await params
  const result = await getChatMessageController(Number(messageId))
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { messageId } = await params
  const body = await req.json()
  const result = await updateChatController(Number(messageId), body)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const { messageId } = await params
  const result = await deleteChatController(Number(messageId))
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
