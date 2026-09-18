import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { listUsers, updateUserStatus, deleteUser } from '@/lib/db';
import { isAdminRequest } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

// Approve/reject/remove pending registrations (Settings page, admin only).
// Was reachable with no auth check at all — any anonymous caller could list
// every user's email/name, approve or reject a registration, or delete any
// account (including the real admin's).
export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  const users = await listUsers(status);
  return NextResponse.json(users.map(u => ({
    id: u.id, email: u.email, name: u.name,
    role: u.role, status: u.status,
    created_at: u.created_at, approved_at: u.approved_at,
  })));
}

export async function PATCH(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const { id, status } = body as { id?: string; status?: string };
  if (!id || !['active', 'rejected'].includes(status ?? '')) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
  await updateUserStatus(id, status!, adminEmail);
  await recordAuditLog(req, 'user.status', { id, status });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  await deleteUser(id);
  await recordAuditLog(req, 'user.delete', { id });
  return NextResponse.json({ ok: true });
}
