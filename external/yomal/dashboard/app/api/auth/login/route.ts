import { NextRequest, NextResponse } from 'next/server'
import { loginController } from '../../controllers/auth'

export async function POST(req: NextRequest) {
  const result = await loginController(req)
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data, { status: result.status })
}
