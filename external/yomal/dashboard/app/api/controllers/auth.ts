import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { findUserByEmail, touchLastLogin } from '../models/user'
import { insertSession, removeSession } from '../models/session'
import { extractBearer } from '../middleware/auth'

export async function loginController(req: NextRequest) {
  const { email, password } = await req.json()

  if (!email || !password) {
    return { error: 'email and password required', status: 400 }
  }

  const user = await findUserByEmail(email)
  if (!user || !user.is_active) {
    return { error: 'invalid credentials', status: 401 }
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return { error: 'invalid credentials', status: 401 }
  }

  const token = jwt.sign(
    { user_id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '24h' }
  )

  await insertSession(
    user.id,
    token,
    req.headers.get('x-forwarded-for') || '',
    req.headers.get('user-agent') || ''
  )
  await touchLastLogin(user.id)

  return {
    data: {
      token,
      user: { id: user.id, email: user.email, role: user.role },
    },
    status: 200,
  }
}

export async function logoutController(req: NextRequest) {
  const token = extractBearer(req)
  if (!token) return { error: 'no token provided', status: 400 }

  await removeSession(token)
  return { data: { message: 'logged out' }, status: 200 }
}
