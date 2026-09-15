import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { listSubscriptions, createSubscription, updateSubscriptionBudget } from '@/lib/db';
import { isAdminRequest } from '@/lib/auth';
import { apiError } from '@/lib/api-error';

export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const subs = await listSubscriptions();
    return NextResponse.json(subs);
  } catch (e) {
    return apiError(e, 'GET /api/subscriptions');
  }
}

export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const body = await req.json();
    const sub = await createSubscription({
      name: body.name,
      subscription_id: body.subscription_id,
      tenant_id: body.tenant_id,
      client_id: body.client_id,
      client_secret: body.client_secret,
    });
    return NextResponse.json(sub, { status: 201 });
  } catch (e) {
    return apiError(e, 'POST /api/subscriptions');
  }
}

/** Currently only used to set/clear a subscription's monthly budget (Cost
 * page's Actual Spend tiles). Extend the body shape here if other fields
 * become editable in place. */
export async function PATCH(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const body = await req.json();
    if (!body.id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const monthlyBudget = body.monthly_budget === null || body.monthly_budget === ''
      ? null
      : Number(body.monthly_budget);
    if (monthlyBudget !== null && (!Number.isFinite(monthlyBudget) || monthlyBudget < 0)) {
      return NextResponse.json({ error: 'monthly_budget must be a non-negative number or null' }, { status: 400 });
    }
    await updateSubscriptionBudget(body.id, monthlyBudget);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, 'PATCH /api/subscriptions');
  }
}
