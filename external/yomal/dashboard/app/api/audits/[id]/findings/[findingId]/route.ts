import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../../middleware/auth'
import { getFindingController, updateFindingController, deleteFindingController } from '../../../../controllers/findings'
import { unauthorized, forbidden } from '../../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; findingId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { findingId } = await params
  const result = await getFindingController(Number(findingId))
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; findingId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { findingId } = await params
  const body = await req.json()
  const result = await updateFindingController(Number(findingId), body)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; findingId: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const { findingId } = await params
  const result = await deleteFindingController(Number(findingId))
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
