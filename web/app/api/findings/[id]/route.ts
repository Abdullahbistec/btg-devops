import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { isAuthenticatedRequest } from '@/lib/auth';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings WHERE id = $1', [params.id]);
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(rows[0]);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

const MAX_TICKET_REF_LENGTH = 200;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { remediation_status, support_ticket_ref } = body as { remediation_status?: string; support_ticket_ref?: string };

    if (remediation_status !== undefined) {
      const allowed = ['open', 'acknowledged', 'resolved', 'suppressed'];
      if (!allowed.includes(remediation_status)) {
        return NextResponse.json({ error: 'Invalid remediation_status' }, { status: 400 });
      }
    }
    if (support_ticket_ref !== undefined && support_ticket_ref.length > MAX_TICKET_REF_LENGTH) {
      return NextResponse.json({ error: `support_ticket_ref must be ${MAX_TICKET_REF_LENGTH} characters or fewer` }, { status: 400 });
    }
    if (remediation_status === undefined && support_ticket_ref === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const db = await getDB();
    if (remediation_status !== undefined) {
      await db.query(`UPDATE findings SET remediation_status = $1 WHERE id = $2`, [remediation_status, params.id]);
    }
    if (support_ticket_ref !== undefined) {
      await db.query(`UPDATE findings SET support_ticket_ref = $1 WHERE id = $2`, [support_ticket_ref, params.id]);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
