import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z, type ZodType } from 'zod';

/** Parses and validates a JSON body.
 *
 * Returns a discriminated union rather than throwing so handlers stay linear
 * and every rejection is an explicit 400 the caller can act on. The zod error
 * itself is deliberately not returned — field names and constraints are
 * schema internals, and H2 is about not handing those out. */
export async function parseBody<T>(
  req: NextRequest,
  schema: ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 }) };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // One field name, no constraint detail: enough for a developer to find
    // the problem, not enough to enumerate the schema.
    const field = parsed.error.issues[0]?.path.join('.') || 'body';
    return {
      ok: false,
      response: NextResponse.json({ error: `Invalid request: check '${field}'` }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

const REMEDIATION_STATUSES = ['open', 'acknowledged', 'resolved', 'suppressed'] as const;

// .strict() everywhere: an unexpected key is a bug or an attempt at mass
// assignment, and silently ignoring it hides both.
export const findingPatchSchema = z
  .object({
    remediation_status: z.enum(REMEDIATION_STATUSES).optional(),
    support_ticket_ref: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    b => b.remediation_status !== undefined || b.support_ticket_ref !== undefined,
    'nothing to update'
  );

// Must divide 24 evenly so every slot lands on the hour — computeNextRun in
// web/lib/schedule-time.ts assumes that and would drift otherwise.
const VALID_TIMES_PER_DAY = [1, 2, 3, 4, 6, 8, 12, 24] as const;

export const schedulePostSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    hour: z.number().int().min(0).max(23),
    times_per_day: z.number().int().refine(n => (VALID_TIMES_PER_DAY as readonly number[]).includes(n)).optional(),
    subscription_id: z.string().max(200).nullable().optional(),
  })
  .strict();

export const schedulePatchSchema = z
  .object({
    id: z.string().min(1).max(200),
    enabled: z.union([z.literal(0), z.literal(1), z.boolean()]),
  })
  .strict();

export const subscriptionPostSchema = z
  .object({
    name: z.string().min(1).max(200),
    subscription_id: z.string().min(1).max(200),
    tenant_id: z.string().min(1).max(200),
    client_id: z.string().min(1).max(200),
    client_secret: z.string().max(500).optional(),
  })
  .strict();

export const subscriptionPatchSchema = z
  .object({
    id: z.string().min(1).max(200),
    monthly_budget: z.union([z.number().nonnegative(), z.literal(''), z.null()]),
  })
  .strict();
