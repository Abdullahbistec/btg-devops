import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../middleware/auth'
import { listChatController, saveChatController, askChatController } from '../../../controllers/chat'
import { unauthorized, forbidden } from '../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id } = await params
  const result = await listChatController(id)
  return NextResponse.json(result.data)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { id } = await params
  const body = await req.json()
  // {content} alone → ask the model (Method 2); {role, content} → raw save (internal use)
  const result = body.role
    ? await saveChatController(id, body, auth)
    : await askChatController(id, body.content, auth, body.provider, body.model, body.scope, body.thread_id)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data, { status: result.status })
}
