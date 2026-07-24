import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { isAdminRequest } from '@/lib/auth';

interface Schedule {
  id: string;
  name: string;
  frequency: string;
  hour: number;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  subscription_id: string | null;
  created_at: string;
}

function computeNextRun(frequency: string, hour: number): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) {
    if (frequency === 'daily') next.setDate(next.getDate() + 1);
    else if (frequency === 'weekly') next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);
  }
  return next.toISOString().slice(0, 19).replace('T', ' ');
}

export async function GET() {
  try {
    const db = getDB();
    const rows = db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all();
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const { name, frequency, hour, subscription_id } = body as Partial<Schedule>;
    const db = getDB();
    const id = uuidv4();
    const next_run = computeNextRun(frequency ?? 'daily', Number(hour ?? 2));
    db.prepare(`
      INSERT INTO schedules (id, name, frequency, hour, enabled, next_run_at, subscription_id)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, name || 'Scheduled Audit', frequency || 'daily', Number(hour ?? 2), next_run, subscription_id || null);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const { id, enabled } = body as { id: string; enabled: number };
    const db = getDB();
    db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const db = getDB();
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
