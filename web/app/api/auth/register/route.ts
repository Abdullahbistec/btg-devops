import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getUserByEmail, createUser } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { sendRegistrationNotification } from '@/lib/mailer';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { email, name, password } = body as { email?: string; name?: string; password?: string };

  if (!email || !name || !password) {
    return NextResponse.json({ error: 'Name, email and password are required' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  const normalEmail = email.trim().toLowerCase();

  // Block if same as env-var admin
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (normalEmail === adminEmail) {
    return NextResponse.json({ error: 'This email is already registered' }, { status: 409 });
  }

  // Check duplicate
  const existing = await getUserByEmail(normalEmail);
  if (existing) {
    return NextResponse.json({ error: 'This email is already registered' }, { status: 409 });
  }

  const id = uuidv4();
  await createUser(id, normalEmail, name.trim(), hashPassword(password));

  // Notify admin
  if (adminEmail) {
    sendRegistrationNotification(adminEmail, normalEmail, name.trim()).catch(console.error);
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
