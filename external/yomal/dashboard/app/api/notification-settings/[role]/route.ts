import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireRole } from '../../middleware/auth'
import { updateRoleSettingController } from '../../controllers/notificationSettings'
import { unauthorized, forbidden } from '../../utils/response'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ role: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const { role } = await params
  const body = await req.json()
  const result = await updateRoleSettingController(role, body)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
