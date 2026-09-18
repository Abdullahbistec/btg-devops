import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getDB } from './db';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Consumes one unit from a fixed-window counter.
 *
 * Fixed window rather than sliding: one row per bucket per window and one
 * atomic statement to claim a slot. A sliding window needs either a row per
 * request or a read-then-write, and neither is worth it for what this
 * defends — password and OTP guessing, email bombing, and repeated triggers
 * of the expensive Azure/Hetzner calls. The known trade-off is that a burst
 * straddling a window boundary can briefly reach 2x the limit. */
export async function consumeRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const db = await getDB();

  const { rows } = await db.query(
    `INSERT INTO rate_limit_hits (bucket, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start)
       DO UPDATE SET count = rate_limit_hits.count + 1
     RETURNING count,
               EXTRACT(EPOCH FROM (window_start + ($2 || ' seconds')::interval - now()))::int AS retry_after`,
    [bucket, windowSeconds]
  );

  const row = rows[0] as { count: number; retry_after: number };
  return {
    allowed: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    retryAfterSeconds: Math.max(1, row.retry_after),
  };
}

/** Deletes counters from windows that can no longer be current. Call
 * opportunistically; nothing depends on it having run. */
export async function pruneRateLimits(): Promise<void> {
  const db = await getDB();
  await db.query(`DELETE FROM rate_limit_hits WHERE window_start < now() - interval '1 day'`);
}

/** Best-effort client address.
 *
 * x-forwarded-for is caller-controlled unless a proxy you trust overwrites
 * it, so this is a speed bump against casual abuse, not an identity. Where a
 * real account is known, limit on that too — see the per-account buckets in
 * the route handlers. Everything unattributable shares the 'unknown' bucket
 * rather than being waved through. */
export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first;
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export function rateLimited(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests. Try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } }
  );
}
