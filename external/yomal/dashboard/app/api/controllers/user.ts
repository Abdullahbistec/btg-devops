import bcrypt from 'bcryptjs'
import { findAllUsers, findUserById, insertUser, patchUser, deleteUser } from '../models/user'
import { JWTPayload } from '../types'

export async function listUsersController() {
  const users = await findAllUsers()
  return {
    data: users.map(u => ({ ...u, password_hash: undefined })),
    status: 200,
  }
}

export async function createUserController(
  body: { email: string; password: string; role: string },
  auth: JWTPayload
) {
  const { email, password, role } = body

  if (!email || !password || !role) {
    return { error: 'email, password and role required', status: 400 }
  }
  if (!['admin', 'analyst', 'viewer'].includes(role)) {
    return { error: 'role must be admin, analyst, or viewer', status: 400 }
  }
  if (password.length < 8) {
    return { error: 'password must be at least 8 characters', status: 400 }
  }

  const hash = await bcrypt.hash(password, 10)
  const id = await insertUser(email, hash, role, auth.user_id)
  return { data: { id }, status: 201 }
}

export async function getUserController(userId: string) {
  const user = await findUserById(userId)
  if (!user) return { error: 'user not found', status: 404 }
  return { data: { ...user, password_hash: undefined }, status: 200 }
}

export async function updateUserController(
  userId: string,
  body: { role?: string; is_active?: boolean },
  auth?: JWTPayload
) {
  const { role, is_active } = body

  if (role && !['admin', 'analyst', 'viewer'].includes(role)) {
    return { error: 'role must be admin, analyst, or viewer', status: 400 }
  }
  if (auth && auth.user_id === userId && role && role !== 'admin') {
    return { error: 'cannot demote your own account', status: 400 }
  }
  if (auth && auth.user_id === userId && is_active === false) {
    return { error: 'cannot deactivate your own account', status: 400 }
  }

  await patchUser(userId, role, is_active)
  return { data: { message: 'updated' }, status: 200 }
}

export async function deleteUserController(userId: string, auth: JWTPayload) {
  if (auth.user_id === userId) {
    return { error: 'cannot delete your own account', status: 400 }
  }
  const deleted = await deleteUser(userId)
  if (!deleted) return { error: 'user not found', status: 404 }
  return { data: { message: 'deleted' }, status: 200 }
}
