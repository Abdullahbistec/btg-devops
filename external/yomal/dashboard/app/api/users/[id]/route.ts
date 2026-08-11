import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../middleware/auth'
import { getUserController, updateUserController, deleteUserController } from '../../controllers/user'
import { unauthorized, forbidden } from '../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const { id } = await params
  const result = await getUserController(id)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const { id } = await params
  const body = await req.json()
  const result = await updateUserController(id, body, auth)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const { id } = await params
  const result = await deleteUserController(id, auth)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
