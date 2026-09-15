import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { isAdminRequest, isAuthenticatedRequest } from '@/lib/auth';
import { computeNextRun } from '@/lib/schedule-time';

interface Schedule {
  id: string;
  name: string;
  frequency: string;
  hour: number;
  times_per_day: number;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  subscription_id: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM schedules ORDER BY created_at DESC');
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const { name, frequency, hour, times_per_day, subscription_id } = body as Partial<Schedule>;
    // Must evenly divide 24 so slots land on the hour every time — anything
    // else (e.g. 5x/day) would drift, which computeNextRun assumes never happens.
    const VALID_TIMES_PER_DAY = [1, 2, 3, 4, 6, 8, 12, 24];
    const timesPerDay = VALID_TIMES_PER_DAY.includes(Number(times_per_day)) ? Number(times_per_day) : 1;
    const db = await getDB();
    const id = uuidv4();
    const next_run = computeNextRun(frequency ?? 'daily', Number(hour ?? 2), new Date(), timesPerDay);
    await db.query(
      `INSERT INTO schedules (id, name, frequency, hour, times_per_day, enabled, next_run_at, subscription_id)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
      [id, name || 'Scheduled Audit', frequency || 'daily', Number(hour ?? 2), timesPerDay, next_run, subscription_id || null]
    );
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const { id, enabled } = body as { id: string; enabled: number };
    const db = await getDB();
    await db.query('UPDATE schedules SET enabled = $1 WHERE id = $2', [enabled ? 1 : 0, id]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const db = await getDB();
    await db.query('DELETE FROM schedules WHERE id = $1', [id]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
