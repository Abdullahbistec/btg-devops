import { findRoleSettings, setRoleEnabled } from '../models/notificationSettings'

const VALID_ROLES = ['admin', 'analyst', 'viewer']

export async function listRoleSettingsController() {
  const settings = await findRoleSettings()
  return { data: settings, status: 200 }
}

export async function updateRoleSettingController(role: string, body: { enabled?: boolean }) {
  if (!VALID_ROLES.includes(role)) {
    return { error: 'role must be admin, analyst, or viewer', status: 400 }
  }
  if (typeof body.enabled !== 'boolean') {
    return { error: 'enabled (boolean) required', status: 400 }
  }
  const updated = await setRoleEnabled(role, body.enabled)
  if (!updated) return { error: 'role setting not found', status: 404 }
  return { data: { message: 'updated' }, status: 200 }
}
