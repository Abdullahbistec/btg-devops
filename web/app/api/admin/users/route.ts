import { NextRequest, NextResponse } from 'next/server';
import { listUsers, updateUserStatus, deleteUser, getUserByEmail, getDB } from '@/lib/db';

function isAdmin(req: NextRequest): boolean {
  const identity = req.cookies.get('btg_identity')?.value ?? '';
  if (!identity) return false;
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (identity === adminEmail) return true;
  try {
    const user = getUserByEmail(identity);
    return user?.role === 'admin' && user?.status === 'active';
  } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  return NextResponse.json(listUsers(status));
}

export async function PATCH(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const { id, status, role } = body as { id?: string; status?: string; role?: string };
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
  if (status && ['active', 'rejected', 'inactive', 'pending'].includes(status)) {
    updateUserStatus(id, status, adminEmail);
  }
  if (role && ['admin', 'viewer'].includes(role)) {
    getDB().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  deleteUser(id);
  return NextResponse.json({ ok: true });
}
