import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '../../../middleware/auth'
import { findAnalysisProgressForAudit } from '../../../models/analysisRequests'
import { unauthorized } from '../../../utils/response'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (!auth) return unauthorized()

  const { id } = await params
  const progress = await findAnalysisProgressForAudit(id)
  return NextResponse.json(progress)
}
