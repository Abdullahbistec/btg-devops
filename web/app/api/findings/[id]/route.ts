import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings WHERE id = $1', [params.id]);
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(rows[0]);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({}));
    const { remediation_status } = body as { remediation_status?: string };
    const allowed = ['open', 'acknowledged', 'resolved', 'suppressed'];
    if (!remediation_status || !allowed.includes(remediation_status)) {
      return NextResponse.json({ error: 'Invalid remediation_status' }, { status: 400 });
    }
    const db = await getDB();
    await db.query(`UPDATE findings SET remediation_status = $1 WHERE id = $2`, [remediation_status, params.id]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
