import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { listSubscriptions, createSubscription } from '@/lib/db';
import { isAdminRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const subs = listSubscriptions();
    return NextResponse.json(subs);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const body = await req.json();
    const sub = createSubscription({
      name: body.name,
      subscription_id: body.subscription_id,
      tenant_id: body.tenant_id,
      client_id: body.client_id,
    });
    return NextResponse.json(sub, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
