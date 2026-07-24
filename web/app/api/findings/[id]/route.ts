import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM findings WHERE id = ?').get(params.id);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(row);
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
    const db = getDB();
    db.prepare(`UPDATE findings SET remediation_status = ? WHERE id = ?`).run(remediation_status, params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
