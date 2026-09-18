import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { randomUUID } from 'crypto';
import { isAdminRequest, isAuthenticatedRequest } from '@/lib/auth';
import { computeNextRun } from '@/lib/schedule-time';
import { apiError } from '@/lib/api-error';
import { parseBody, schedulePostSchema, schedulePatchSchema } from '@/lib/schemas';
import { recordAuditLog } from '@/lib/audit-log';

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM schedules ORDER BY created_at DESC');
    return NextResponse.json(rows);
  } catch (e) {
    return apiError(e, 'GET /api/schedule');
  }
}

export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const parsed = await parseBody(req, schedulePostSchema);
    if (!parsed.ok) return parsed.response;
    const { name, frequency, hour, times_per_day, subscription_id } = parsed.data;
    const timesPerDay = times_per_day ?? 1;
    const db = await getDB();
    const id = randomUUID();
    const next_run = computeNextRun(frequency ?? 'daily', Number(hour ?? 2), new Date(), timesPerDay);
    await db.query(
      `INSERT INTO schedules (id, name, frequency, hour, times_per_day, enabled, next_run_at, subscription_id)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
      [id, name || 'Scheduled Audit', frequency || 'daily', Number(hour ?? 2), timesPerDay, next_run, subscription_id || null]
    );
    await recordAuditLog(req, 'schedule.create', { id, name, frequency, hour, times_per_day: timesPerDay });
    return NextResponse.json({ id });
  } catch (e) {
    return apiError(e, 'POST /api/schedule');
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const parsed = await parseBody(req, schedulePatchSchema);
    if (!parsed.ok) return parsed.response;
    const { id, enabled } = parsed.data;
    const db = await getDB();
    await db.query('UPDATE schedules SET enabled = $1 WHERE id = $2', [Boolean(enabled), id]);
    await recordAuditLog(req, 'schedule.toggle', { id, enabled: Boolean(enabled) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, 'PATCH /api/schedule');
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const db = await getDB();
    await db.query('DELETE FROM schedules WHERE id = $1', [id]);
    await recordAuditLog(req, 'schedule.delete', { id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, 'DELETE /api/schedule');
  }
}
