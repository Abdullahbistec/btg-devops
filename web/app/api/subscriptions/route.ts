import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { listSubscriptions, createSubscription, updateSubscriptionBudget } from '@/lib/db';
import { isAdminRequest } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { parseBody, subscriptionPostSchema, subscriptionPatchSchema } from '@/lib/schemas';

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
    const parsed = await parseBody(req, subscriptionPostSchema);
    if (!parsed.ok) return parsed.response;
    const sub = await createSubscription(parsed.data);
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
    const parsed = await parseBody(req, subscriptionPatchSchema);
    if (!parsed.ok) return parsed.response;
    const monthlyBudget = parsed.data.monthly_budget === '' || parsed.data.monthly_budget === null
      ? null
      : parsed.data.monthly_budget;
    await updateSubscriptionBudget(parsed.data.id, monthlyBudget);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, 'PATCH /api/subscriptions');
  }
}
