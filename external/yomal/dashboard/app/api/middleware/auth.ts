import { NextRequest } from 'next/server'
import jwt from 'jsonwebtoken'
import { findSession } from '../models/session'
import { JWTPayload } from '../types'

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload
  } catch {
    return null
  }
}

export function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}

export async function requireAuth(req: NextRequest): Promise<JWTPayload | null> {
  const token = extractBearer(req)
  if (!token) return null

  const payload = verifyToken(token)
  if (!payload) return null

  const userId = await findSession(token)
  if (!userId) return null

  return payload
}

export function requireRole(auth: JWTPayload, roles: string[]): boolean {
  return roles.includes(auth.role)
}
