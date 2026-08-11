import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../../middleware/auth'
import { runAnalysisController, getAnalysisController, deleteAnalysisController } from '../../../controllers/audit'
import { unauthorized, forbidden } from '../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id } = await params
  const result = await getAnalysisController(id)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin', 'analyst'])) return forbidden()

  const { id } = await params
  const resource = req.nextUrl.searchParams.get('resource') || undefined
  const provider = req.nextUrl.searchParams.get('provider') || undefined
  const model = req.nextUrl.searchParams.get('model') || undefined
  const result = await runAnalysisController(id, resource, provider, model)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const { id } = await params
  const result = await deleteAnalysisController(id)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
