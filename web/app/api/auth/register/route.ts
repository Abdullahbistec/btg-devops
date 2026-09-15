import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { getUserByEmail, createUser } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { sendRegistrationNotification } from '@/lib/mailer';
import { consumeRateLimit, clientIp, rateLimited } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { email, name, password } = body as { email?: string; name?: string; password?: string };

  if (!email || !name || !password) {
    return NextResponse.json({ error: 'Name, email and password are required' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  // Registration is open to anyone and every attempt writes a users row that
  // an admin then has to triage. Five an hour per address is generous for a
  // human and useless for a flood.
  const byIp = await consumeRateLimit(`register:ip:${clientIp(req)}`, 5, 3600);
  if (!byIp.allowed) return rateLimited(byIp);

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

  const id = randomUUID();
  await createUser(id, normalEmail, name.trim(), hashPassword(password));

  // Notify admin
  if (adminEmail) {
    sendRegistrationNotification(adminEmail, normalEmail, name.trim()).catch(console.error);
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
