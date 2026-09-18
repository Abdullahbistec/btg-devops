import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { isAuthenticatedRequest } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { parseBody, findingPatchSchema } from '@/lib/schemas';
import { recordAuditLog } from '@/lib/audit-log';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings WHERE id = $1', [id]);
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(rows[0]);
  } catch (e) {
    return apiError(e, 'GET /api/findings/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const parsed = await parseBody(req, findingPatchSchema);
    if (!parsed.ok) return parsed.response;
    const { remediation_status, support_ticket_ref } = parsed.data;

    const db = await getDB();
    if (remediation_status !== undefined) {
      await db.query(`UPDATE findings SET remediation_status = $1 WHERE id = $2`, [remediation_status, id]);
    }
    if (support_ticket_ref !== undefined) {
      await db.query(`UPDATE findings SET support_ticket_ref = $1 WHERE id = $2`, [support_ticket_ref, id]);
    }
    await recordAuditLog(req, 'finding.update', { id, remediation_status, support_ticket_ref });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, 'PATCH /api/findings/[id]');
  }
}
