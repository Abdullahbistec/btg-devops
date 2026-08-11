import { NextRequest } from 'next/server'
import { requireAuth, requireRole } from '../middleware/auth'
import { listRoleSettingsController } from '../controllers/notificationSettings'
import { unauthorized, forbidden, ok } from '../utils/response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()
  if (!requireRole(auth, ['admin'])) return forbidden()

  const result = await listRoleSettingsController()
  return ok(result.data)
}
