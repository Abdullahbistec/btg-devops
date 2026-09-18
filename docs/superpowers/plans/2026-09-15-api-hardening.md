# API Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close H2 and M2 from the security review and land two roadmap items — stop returning raw exception text to callers, add per-IP and per-account rate limiting to the auth and expensive endpoints, validate request bodies at the boundary, and record an audit trail of privileged actions.

**Architecture:** One `apiError()` helper replaces 25 hand-rolled `catch` blocks that currently return `(e as Error).message` — callers get a generic message plus a correlation id, and the real detail goes to the server log under that id. Rate limiting is a fixed-window counter in Postgres (`rate_limit_hits`), incremented by a single atomic upsert so it works across instances, applied only to endpoints that authenticate or spend money — never to the polling reads the dashboard and the scheduled workflow depend on. Request bodies are parsed through `zod` schemas on the mutating routes. Privileged actions append to an `audit_log` table.

**Tech Stack:** Next.js 14 App Router + TypeScript, PostgreSQL via `pg`, `zod` (new dependency), vitest against a real `btg_devops_test` database.

**Spec:** `docs/security-static-review-2026-09.md` — findings H2, M2, and roadmap §5 items 6 and 7.

## Global Constraints

- **Never rate-limit a polling read.** `scripts/run-scheduled-audit.js` polls `GET /api/audits` every 3 seconds for up to 200 iterations (~20 req/min sustained for 10 minutes), and `web/app/cost/page.tsx` polls `GET /api/cost-requests/:id` through a 10-minute window. Limiting either breaks the scheduled GitHub Actions workflow and the Refresh button. Task 3 lists the exact endpoints that *are* limited and the traffic each must tolerate.
- **Preserve domain-meaningful errors.** `apiError()` replaces only the generic 500 catch-alls. `audits/run`'s `AuditExecutorError → 404` branch, `cost-requests`'s backfill note, and every explicit 400/401/403/404/409 stay exactly as they are — they are the API's contract, not leakage.
- **`web/middleware.ts` runs in the Edge runtime.** It must never import `@/lib/db`, `@/lib/auth`, or anything reaching `pg` or `node:crypto`. Rate limiting therefore lives in the route handlers, not in middleware.
- **New tables go in `initSchema()` in `web/lib/db.ts`**, inside the existing `CREATE TABLE IF NOT EXISTS` block.
- **`vitest.config.ts` sets `fileParallelism: false`.** Test files share one physical database; db-touching tests must assert `current_database()` ends in `_test` first.
- Run `cd web && npm test` and `cd web && npx tsc --noEmit` before every commit.

---

### Task 1: One error helper, no raw exception text (H2)

25 catch blocks across 17 files return `(e as Error).message` to the caller. For a `pg` error that string carries table names, column names and constraint details; for a filesystem error it carries absolute paths. That is free reconnaissance for anyone probing the API.

**Files:**
- Create: `web/lib/api-error.ts`
- Create: `web/lib/api-error.test.ts`
- Modify (25 catch blocks across 17 files — exact counts from `grep -c '(e as Error).message'`):
  `subscriptions/route.ts` (3), `schedule/route.ts` (4), `cost-requests/route.ts` (3),
  `findings/[id]/route.ts` (2), `dashboard/route.ts` (1), `findings/route.ts` (1),
  `cost/spend/route.ts` (1), `cost/history/route.ts` (1), `cost/hetzner/route.ts` (1),
  `cost/hetzner/history/route.ts` (1), `cost/hetzner/backfill/route.ts` (1),
  `subscriptions/compare/route.ts` (1), `audits/route.ts` (1), `audits/run/route.ts` (1),
  `analysis-requests/route.ts` (1), `admin/notify/route.ts` (1),
  `internal/cost-requests/[id]/fetch/route.ts` (1)

**Interfaces:**
- Consumes: nothing new.
- Produces: `apiError(e: unknown, context: string): NextResponse` — logs `[api-error <uuid>] <context>: <error>` to stderr and returns `{ error: string, correlationId: string }` with status 500.

- [ ] **Step 1: Write the failing test**

Create `web/lib/api-error.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiError } from './api-error';

afterEach(() => vi.restoreAllMocks());

describe('apiError', () => {
  it('does not leak the exception message to the caller', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pgish = new Error('relation "findings" does not exist at character 15');

    const body = await apiError(pgish, 'GET /api/findings').json();

    expect(JSON.stringify(body)).not.toContain('findings');
    expect(JSON.stringify(body)).not.toContain('character 15');
  });

  it('returns 500 and a correlation id the caller can quote', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await apiError(new Error('boom'), 'GET /api/findings');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.error).toBe('string');
  });

  it('logs the real detail server-side under the same correlation id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error('constraint "findings_audit_id_fkey" violated');

    const body = await apiError(original, 'PATCH /api/findings/[id]').json();

    const logged = spy.mock.calls[0].join(' ');
    expect(logged).toContain(body.correlationId);
    expect(logged).toContain('PATCH /api/findings/[id]');
    expect(spy.mock.calls[0]).toContain(original);
  });

  it('handles a thrown non-Error without crashing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await apiError('just a string', 'GET /api/dashboard');
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd web && npx vitest run lib/api-error.test.ts`
Expected: FAIL — `Failed to resolve import "./api-error"`.

- [ ] **Step 3: Write the helper**

Create `web/lib/api-error.ts`:

```ts
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

/** Generic 500 for an unexpected failure.
 *
 * The routes used to return `(e as Error).message` straight to the caller,
 * which for a pg error is the table name, the column name and the constraint
 * that failed — free schema reconnaissance for anyone probing the API. The
 * detail still exists, it just goes to the server log under a correlation id
 * the caller can quote in a bug report.
 *
 * Only for *unexpected* failures. Deliberate 400/401/403/404/409 responses
 * are the API's contract and must keep their own specific messages. */
export function apiError(e: unknown, context: string): NextResponse {
  const correlationId = randomUUID();
  console.error(`[api-error ${correlationId}] ${context}:`, e);
  return NextResponse.json(
    {
      error: 'Something went wrong on our side. Quote this reference if you report it.',
      correlationId,
    },
    { status: 500 }
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd web && npx vitest run lib/api-error.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit the helper before rolling it out**

```bash
git add web/lib/api-error.ts web/lib/api-error.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add apiError() — generic 500 plus a logged correlation id

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Enumerate every site to change**

Run: `cd web && grep -rn "(e as Error).message" app/api`

Expected: 25 lines across the 17 files listed under **Files** above. Work the list top to bottom. If the count differs from 25, the codebase has moved since this plan was written — reconcile before continuing rather than guessing.

- [ ] **Step 7: Replace each generic catch**

For each hit, the mechanical change is the same. Add the import at the top of the file:

```ts
import { apiError } from '@/lib/api-error';
```

and rewrite the catch. For example, in `web/app/api/findings/route.ts`:

```ts
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
```

becomes:

```ts
  } catch (e) {
    return apiError(e, 'GET /api/findings');
  }
```

The `context` string is `<METHOD> <route path>` — it is what makes a log line searchable, so give each handler its own, matching the file's route and the exported function's method. In a file with several handlers (`schedule/route.ts` has four: GET, POST, PATCH, DELETE) each gets its own context string.

**Two exceptions — do not convert these:**

1. `web/app/api/audits/run/route.ts` — keep the typed branch, convert only the fallthrough:

```ts
  } catch (e) {
    if (e instanceof AuditExecutorError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    return apiError(e, 'POST /api/audits/run');
  }
```

`AuditExecutorError`'s message is written by this codebase for the user to read — it is a contract, not a leak.

2. `web/app/api/cost-requests/route.ts` — the inner Hetzner branch's `catch` wraps a call whose message the Cost page displays. Convert the two outer catches to `apiError(e, 'POST /api/cost-requests')`; for the Hetzner branch, keep the shape but stop returning the raw message:

```ts
      } catch (e) {
        return apiError(e, 'POST /api/cost-requests (hetzner refresh)');
      }
```

`web/app/cost/page.tsx` reads `body.error` and renders it, so it will now show the generic text plus the reference — which is the intended behaviour.

- [ ] **Step 8: Check nothing still leaks**

Run: `cd web && grep -rn "(e as Error).message" app/api || echo "NONE FOUND"`
Expected: `NONE FOUND`.

- [ ] **Step 9: Verify with the existing route tests**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean and green. `web/lib/route-auth.test.ts` asserts status codes, not bodies, so it is unaffected; `costRequests.test.ts` asserts `403`/`not 403`, also unaffected.

- [ ] **Step 10: Commit the rollout**

```bash
git add web/app/api
git commit -m "$(cat <<'EOF'
fix(api): stop returning raw exception text from every route

Postgres error strings carry table, column and constraint names; filesystem
errors carry absolute paths. Both went straight to the caller. They now go to
the server log under a correlation id the response quotes instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: A Postgres-backed rate-limit counter (M2, part 1)

**Files:**
- Modify: `web/lib/db.ts` — add `rate_limit_hits` to `initSchema()`
- Create: `web/lib/rate-limit.ts`
- Create: `web/lib/rate-limit.test.ts`

**Interfaces:**
- Consumes: `getDB()` from `web/lib/db.ts`.
- Produces:
  - `interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }`
  - `consumeRateLimit(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult>`
  - `clientIp(req: NextRequest): string`
  - `rateLimited(result: RateLimitResult): NextResponse` — the 429 response, with a `Retry-After` header.

- [ ] **Step 1: Add the table**

In `web/lib/db.ts`, inside the `initSchema()` DDL block, after the `otp_codes` table (or after `users` if Plan A has not landed yet), add:

```sql
    -- Fixed-window rate-limit counters. `bucket` encodes what is being
    -- limited and for whom, e.g. 'login:ip:203.0.113.4'. `window_start` is
    -- the epoch floored to the window size, so a row is one counter for one
    -- window and the whole check is a single atomic upsert — no read-then-
    -- write race, and it holds across instances, which an in-process Map
    -- would not.
    CREATE TABLE IF NOT EXISTS rate_limit_hits (
      bucket       TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_hits(window_start);
```

- [ ] **Step 2: Write the failing tests**

Create `web/lib/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { consumeRateLimit, clientIp, rateLimited } from './rate-limit';

async function resetBuckets() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM rate_limit_hits');
}

describe('consumeRateLimit', () => {
  beforeEach(resetBuckets);

  it('allows requests up to the limit and refuses the one after', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit('test:a', 3, 900)).allowed).toBe(true);
    }
    expect((await consumeRateLimit('test:a', 3, 900)).allowed).toBe(false);
  });

  it('reports how many attempts are left', async () => {
    expect((await consumeRateLimit('test:b', 3, 900)).remaining).toBe(2);
    expect((await consumeRateLimit('test:b', 3, 900)).remaining).toBe(1);
    expect((await consumeRateLimit('test:b', 3, 900)).remaining).toBe(0);
  });

  it('keeps separate buckets separate', async () => {
    await consumeRateLimit('test:c', 1, 900);
    expect((await consumeRateLimit('test:c', 1, 900)).allowed).toBe(false);
    expect((await consumeRateLimit('test:d', 1, 900)).allowed).toBe(true);
  });

  it('counts concurrent calls atomically', async () => {
    // The point of doing this in SQL: ten simultaneous requests must not all
    // read count=0. Exactly three may pass a limit of three.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit('test:race', 3, 900))
    );
    expect(results.filter(r => r.allowed)).toHaveLength(3);
  });

  it('gives a positive retry-after once the limit is hit', async () => {
    await consumeRateLimit('test:e', 1, 900);
    const blocked = await consumeRateLimit('test:e', 1, 900);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('starts a fresh count in a new window', async () => {
    await consumeRateLimit('test:f', 1, 900);
    expect((await consumeRateLimit('test:f', 1, 900)).allowed).toBe(false);

    // Age the row out of the current window rather than waiting 15 minutes.
    const db = await getDB();
    await db.query(`UPDATE rate_limit_hits SET window_start = window_start - interval '1 hour' WHERE bucket = 'test:f'`);

    expect((await consumeRateLimit('test:f', 1, 900)).allowed).toBe(true);
  });
});

describe('clientIp', () => {
  it('takes the first entry of x-forwarded-for', () => {
    const req = new NextRequest('http://localhost/api/auth/login', {
      headers: { 'x-forwarded-for': '203.0.113.4, 70.41.3.18' },
    });
    expect(clientIp(req)).toBe('203.0.113.4');
  });

  it('falls back to a constant when the header is absent', () => {
    // Everything unattributable shares one bucket — deliberately strict, so a
    // missing header cannot be used to escape limiting altogether.
    expect(clientIp(new NextRequest('http://localhost/api/auth/login'))).toBe('unknown');
  });
});

describe('rateLimited', () => {
  it('returns 429 with a Retry-After header', async () => {
    const res = rateLimited({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd web && npx vitest run lib/rate-limit.test.ts`
Expected: FAIL — `Failed to resolve import "./rate-limit"`.

- [ ] **Step 4: Implement**

Create `web/lib/rate-limit.ts`:

```ts
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
 * `x-forwarded-for` is caller-controlled unless a proxy you trust overwrites
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
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/rate-limit.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add web/lib/db.ts web/lib/rate-limit.ts web/lib/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add a Postgres fixed-window rate-limit counter

One atomic upsert per check, so the limit holds across instances and
concurrent requests cannot all observe the same pre-increment count.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Apply limits to the auth and expensive endpoints (M2, part 2)

**What gets limited, and what traffic each must tolerate.** These numbers are not arbitrary — they come from the real callers.

| Endpoint | Bucket | Limit | Must not break |
|---|---|---|---|
| `POST /api/auth/login` | `login:ip:<ip>` and `login:email:<email>` | 10 / 15 min | CI logs in twice per workflow run, 4 runs/day (`run-scheduled-audit.js`, `run-scheduled-cost-refresh.js`) |
| `POST /api/auth/register` | `register:ip:<ip>` | 5 / hour | Human registration only |
| `POST /api/auth/resend-otp` | `resend:email:<email>` | 3 / 15 min **plus** a 60-second cooldown | A person clicking "resend" |
| `POST /api/audits/run` | `audits-run:account:<identity>` | 10 / hour | CI triggers 1 per run, 4 runs/day |
| `POST /api/cost/hetzner/backfill` | `hetzner-backfill:account:<identity>` | 3 / hour | Manual button |
| `POST /api/cost-requests` | `cost-requests:account:<identity>` | 20 / hour | CI posts 1 per subscription per run |

**Explicitly NOT limited** — limiting any of these breaks a working feature:
`GET /api/audits` (polled every 3s for up to 10 minutes by `run-scheduled-audit.js`),
`GET /api/cost-requests/:id` and `GET /api/analysis-requests/:id` (polled by the Cost and Audits pages),
and every other read. They are already behind authentication after C1–C3.

**Files:**
- Modify: `web/app/api/auth/login/route.ts`
- Modify: `web/app/api/auth/register/route.ts`
- Modify: `web/app/api/auth/resend-otp/route.ts`
- Modify: `web/app/api/audits/run/route.ts`
- Modify: `web/app/api/cost/hetzner/backfill/route.ts`
- Modify: `web/app/api/cost-requests/route.ts`
- Test: `web/lib/rate-limit-routes.test.ts` (create)

**Interfaces:**
- Consumes: `consumeRateLimit`, `clientIp`, `rateLimited` from `web/lib/rate-limit.ts`; `getVerifiedIdentity` from `web/lib/auth.ts`.
- Produces: no new exports. Each listed route returns 429 with `Retry-After` when over its limit.

- [ ] **Step 1: Write the failing tests**

Create `web/lib/rate-limit-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as register } from '@/app/api/auth/register/route';

const SAVED = { ...process.env };

async function reset() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM rate_limit_hits');
  await db.query('DELETE FROM otp_codes');
  await db.query('DELETE FROM users');
}

function loginRequest(ip: string, email = 'nobody@example.com') {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: 'wrong-password' }),
  });
}

describe('POST /api/auth/login — rate limited', () => {
  beforeEach(async () => {
    await reset();
    process.env.SESSION_SECRET = 'test-session-secret';
    process.env.ADMIN_EMAIL = 'admin@example.com';
  });
  afterEach(() => { process.env = { ...SAVED }; });

  it('starts returning 429 once one address exceeds the limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await login(loginRequest('203.0.113.4'))).status);
    }
    // First 10 are ordinary auth failures (401), the rest are throttled.
    expect(statuses.slice(0, 10).every(s => s !== 429)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('sets Retry-After on the 429', async () => {
    let res!: Response;
    for (let i = 0; i < 11; i++) res = await login(loginRequest('203.0.113.9'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not let one address exhaust another address\'s budget', async () => {
    for (let i = 0; i < 11; i++) await login(loginRequest('203.0.113.4'));
    expect((await login(loginRequest('198.51.100.7'))).status).not.toBe(429);
  });

  it('throttles guesses against one account even when the source address rotates', async () => {
    // Password spraying from a botnet: a per-IP limit alone never fires.
    for (let i = 0; i < 11; i++) {
      await login(loginRequest(`198.51.100.${i}`, 'victim@example.com'));
    }
    expect((await login(loginRequest('203.0.113.200', 'victim@example.com'))).status).toBe(429);
  });
});

describe('POST /api/auth/register — rate limited', () => {
  beforeEach(async () => {
    await reset();
    process.env.ADMIN_EMAIL = 'admin@example.com';
  });
  afterEach(() => { process.env = { ...SAVED }; });

  it('stops one address flooding the users table', async () => {
    const attempt = (n: number) => register(new NextRequest('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
      body: JSON.stringify({ email: `flood${n}@example.com`, name: `Flood ${n}`, password: 'password123' }),
    }));

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await attempt(i)).status);

    expect(statuses.slice(0, 5).every(s => s !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);

    const db = await getDB();
    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM users');
    expect(rows[0].c).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd web && npx vitest run lib/rate-limit-routes.test.ts`
Expected: FAIL — no 429 is ever returned, so `statuses.slice(10)` is `[401, 401]` and the register test finds 7 rows.

- [ ] **Step 3: Limit the login route**

In `web/app/api/auth/login/route.ts`, add the import:

```ts
import { consumeRateLimit, clientIp, rateLimited } from '@/lib/rate-limit';
```

Change the handler signature from `export async function POST(req: Request)` to:

```ts
export async function POST(req: NextRequest) {
```

and add `import type { NextRequest } from 'next/server';` at the top. Then, immediately after `const normalEmail = email.trim().toLowerCase();`, insert:

```ts
  // Two buckets on purpose: the per-IP one stops a single host grinding
  // through passwords, and the per-account one stops a spray from many hosts
  // against one victim, which a per-IP limit never sees.
  const byIp = await consumeRateLimit(`login:ip:${clientIp(req)}`, 10, 900);
  const byAccount = await consumeRateLimit(`login:email:${normalEmail}`, 10, 900);
  if (!byIp.allowed) return rateLimited(byIp);
  if (!byAccount.allowed) return rateLimited(byAccount);
```

Place it *after* the `email`/`password` presence check so a malformed body still returns 400, and *before* any password comparison or database lookup.

- [ ] **Step 4: Limit the register route**

In `web/app/api/auth/register/route.ts`, add:

```ts
import type { NextRequest } from 'next/server';
import { consumeRateLimit, clientIp, rateLimited } from '@/lib/rate-limit';
```

change `export async function POST(req: Request)` to `export async function POST(req: NextRequest)`, and insert after the `password.length < 8` check:

```ts
  // Registration is open to anyone and every attempt writes a users row that
  // an admin then has to triage. Five an hour per address is generous for a
  // human and useless for a flood.
  const byIp = await consumeRateLimit(`register:ip:${clientIp(req)}`, 5, 3600);
  if (!byIp.allowed) return rateLimited(byIp);
```

- [ ] **Step 5: Limit resend-otp, with a cooldown**

In `web/app/api/auth/resend-otp/route.ts`, add:

```ts
import { consumeRateLimit, rateLimited } from '@/lib/rate-limit';
```

and insert after the `pendingEmail` check:

```ts
  // Each resend sends an email, so this is both a brute-force control and a
  // spend/abuse control on the mail provider. The 60-second cooldown is a
  // second bucket with a limit of one — cheaper than tracking a timestamp.
  const cooldown = await consumeRateLimit(`resend-cooldown:${pendingEmail.toLowerCase()}`, 1, 60);
  if (!cooldown.allowed) return rateLimited(cooldown);

  const window = await consumeRateLimit(`resend:email:${pendingEmail.toLowerCase()}`, 3, 900);
  if (!window.allowed) return rateLimited(window);
```

- [ ] **Step 6: Limit the three expensive authenticated routes**

Each of these already runs `isAdminRequest(req)`; the limit goes *after* the auth check, keyed on the caller's verified identity, so an anonymous caller is rejected as 403 and never touches the counter.

In `web/app/api/audits/run/route.ts`, add:

```ts
import { getVerifiedIdentity } from '@/lib/auth';
import { consumeRateLimit, rateLimited } from '@/lib/rate-limit';
```

and immediately after the `isAdminRequest` guard returns:

```ts
    const limit = await consumeRateLimit(`audits-run:account:${getVerifiedIdentity(req)}`, 10, 3600);
    if (!limit.allowed) return rateLimited(limit);
```

In `web/app/api/cost/hetzner/backfill/route.ts`, same imports, and after its `isAdminRequest` guard:

```ts
  const limit = await consumeRateLimit(`hetzner-backfill:account:${getVerifiedIdentity(req)}`, 3, 3600);
  if (!limit.allowed) return rateLimited(limit);
```

In `web/app/api/cost-requests/route.ts`, same imports, and after its `isAdminRequest` guard:

```ts
    // 20/hour comfortably covers the scheduled refresh (one per subscription,
    // four workflow runs a day) and a person clicking Refresh, while capping
    // how hard this route can be made to hammer Azure Cost Management's
    // tenant-wide rate limit.
    const limit = await consumeRateLimit(`cost-requests:account:${getVerifiedIdentity(req)}`, 20, 3600);
    if (!limit.allowed) return rateLimited(limit);
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/rate-limit-routes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Confirm the scheduled workflow still fits**

Re-read `scripts/run-scheduled-audit.js` and `scripts/run-scheduled-cost-refresh.js` and confirm against the table at the top of this task:
- each script performs exactly one `POST /api/auth/login` per invocation (limit 10/15 min — fits)
- `run-scheduled-audit.js` performs one `POST /api/audits/run` then polls `GET /api/audits` (unlimited — fits)
- `run-scheduled-cost-refresh.js` performs one `GET /api/subscriptions` then one `POST /api/cost-requests` per subscription (limit 20/hour — fits unless there are more than 20 subscriptions; check `SELECT COUNT(*) FROM subscriptions` and raise the limit if that is ever untrue)

- [ ] **Step 9: Run the whole suite and commit**

Run: `cd web && npx tsc --noEmit && npm test`

```bash
git add web/app/api/auth/login/route.ts web/app/api/auth/register/route.ts \
        web/app/api/auth/resend-otp/route.ts web/app/api/audits/run/route.ts \
        web/app/api/cost/hetzner/backfill/route.ts web/app/api/cost-requests/route.ts \
        web/lib/rate-limit-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(api): rate-limit the auth and expensive endpoints

Per-IP and per-account buckets on login, register, resend-otp, audits/run,
hetzner backfill and cost-requests. Polling reads are deliberately excluded —
the scheduled workflow polls /api/audits every 3s for up to 10 minutes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Validate request bodies at the boundary (roadmap §5 item 6)

Handlers currently destructure `await req.json()` and check fields ad hoc. That leaves each route to remember its own validation, and nothing rejects unexpected fields. A schema per mutating route makes the contract explicit and closes type-confusion and mass-assignment shapes in one place.

Scope is deliberately the routes whose bodies change state. Read-only routes take query parameters, which are already narrow.

**Files:**
- Modify: `web/package.json` — add `zod`
- Create: `web/lib/schemas.ts`
- Create: `web/lib/schemas.test.ts`
- Modify: `web/app/api/findings/[id]/route.ts` — PATCH
- Modify: `web/app/api/schedule/route.ts` — POST and PATCH
- Modify: `web/app/api/subscriptions/route.ts` — POST and PATCH

**Interfaces:**
- Consumes: `zod`.
- Produces:
  - `findingPatchSchema`, `schedulePostSchema`, `schedulePatchSchema`, `subscriptionPostSchema`, `subscriptionPatchSchema`
  - `parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }>`

- [ ] **Step 1: Install zod**

Run: `cd web && npm install zod`
Then confirm `web/package.json` lists `zod` under `dependencies`.

- [ ] **Step 2: Write the failing tests**

Create `web/lib/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { parseBody, findingPatchSchema, schedulePostSchema } from './schemas';

function jsonRequest(body: unknown) {
  return new NextRequest('http://localhost/api/whatever', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('parseBody', () => {
  it('accepts a valid body and hands back typed data', async () => {
    const result = await parseBody(jsonRequest({ remediation_status: 'resolved' }), findingPatchSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.remediation_status).toBe('resolved');
  });

  it('rejects an unknown remediation_status with 400', async () => {
    const result = await parseBody(jsonRequest({ remediation_status: 'deleted' }), findingPatchSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it('rejects fields the schema does not declare', async () => {
    // Mass assignment: nothing should be able to smuggle extra columns past
    // a handler that only reads the two it knows about.
    const result = await parseBody(
      jsonRequest({ remediation_status: 'open', audit_id: 'somebody-elses-audit' }),
      findingPatchSchema
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a body that is not an object at all', async () => {
    const req = new NextRequest('http://localhost/api/whatever', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '"just a string"',
    });
    const result = await parseBody(req, findingPatchSchema);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON with 400 rather than throwing', async () => {
    const req = new NextRequest('http://localhost/api/whatever', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{ not json',
    });
    const result = await parseBody(req, findingPatchSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it('does not leak the schema internals in the error body', async () => {
    const result = await parseBody(jsonRequest({ remediation_status: 'nope' }), findingPatchSchema);
    if (!result.ok) {
      const body = await result.response.json();
      expect(JSON.stringify(body)).not.toContain('ZodError');
    }
  });
});

describe('findingPatchSchema', () => {
  it('requires at least one of the two updatable fields', async () => {
    const result = await parseBody(jsonRequest({}), findingPatchSchema);
    expect(result.ok).toBe(false);
  });

  it('caps support_ticket_ref at 200 characters', async () => {
    const result = await parseBody(jsonRequest({ support_ticket_ref: 'x'.repeat(201) }), findingPatchSchema);
    expect(result.ok).toBe(false);
  });
});

describe('schedulePostSchema', () => {
  it('only accepts times_per_day values that divide 24 evenly', async () => {
    // computeNextRun assumes slots land on the hour; 5 would drift.
    const ok = await parseBody(jsonRequest({ frequency: 'daily', hour: 2, times_per_day: 4 }), schedulePostSchema);
    expect(ok.ok).toBe(true);

    const bad = await parseBody(jsonRequest({ frequency: 'daily', hour: 2, times_per_day: 5 }), schedulePostSchema);
    expect(bad.ok).toBe(false);
  });

  it('rejects an hour outside 0-23', async () => {
    const result = await parseBody(jsonRequest({ frequency: 'daily', hour: 24 }), schedulePostSchema);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd web && npx vitest run lib/schemas.test.ts`
Expected: FAIL — `Failed to resolve import "./schemas"`.

- [ ] **Step 4: Implement the schemas**

Create `web/lib/schemas.ts`:

```ts
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

// `.strict()` everywhere: an unexpected key is a bug or an attempt at mass
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
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/schemas.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Use the schema in the findings PATCH handler**

In `web/app/api/findings/[id]/route.ts`, add:

```ts
import { parseBody, findingPatchSchema } from '@/lib/schemas';
```

Replace everything in the PATCH handler between the auth guard and `const db = await getDB();` — that is, the manual body read, the `allowed` array check, the length check and the "Nothing to update" check — with:

```ts
    const parsed = await parseBody(req, findingPatchSchema);
    if (!parsed.ok) return parsed.response;
    const { remediation_status, support_ticket_ref } = parsed.data;
```

The `MAX_TICKET_REF_LENGTH` constant at the top of the file is now unused — delete it. The schema's `.max(200)` is the single source of that rule.

- [ ] **Step 7: Use the schemas in the schedule handlers**

In `web/app/api/schedule/route.ts`, add:

```ts
import { parseBody, schedulePostSchema, schedulePatchSchema } from '@/lib/schemas';
```

In POST, replace the body read and the `VALID_TIMES_PER_DAY` filtering with:

```ts
    const parsed = await parseBody(req, schedulePostSchema);
    if (!parsed.ok) return parsed.response;
    const { name, frequency, hour, times_per_day, subscription_id } = parsed.data;
    const timesPerDay = times_per_day ?? 1;
```

and delete the now-unused local `VALID_TIMES_PER_DAY` array. In PATCH, replace the body read with:

```ts
    const parsed = await parseBody(req, schedulePatchSchema);
    if (!parsed.ok) return parsed.response;
    const { id, enabled } = parsed.data;
```

- [ ] **Step 8: Use the schemas in the subscriptions handlers**

In `web/app/api/subscriptions/route.ts`, add:

```ts
import { parseBody, subscriptionPostSchema, subscriptionPatchSchema } from '@/lib/schemas';
```

In POST, replace `const body = await req.json();` and the `createSubscription({...})` argument construction with:

```ts
    const parsed = await parseBody(req, subscriptionPostSchema);
    if (!parsed.ok) return parsed.response;
    const sub = await createSubscription(parsed.data);
```

In PATCH, replace the body read and the manual `id`/`monthly_budget` validation with:

```ts
    const parsed = await parseBody(req, subscriptionPatchSchema);
    if (!parsed.ok) return parsed.response;
    const monthlyBudget = parsed.data.monthly_budget === '' || parsed.data.monthly_budget === null
      ? null
      : parsed.data.monthly_budget;
    await updateSubscriptionBudget(parsed.data.id, monthlyBudget);
```

- [ ] **Step 9: Run everything**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean and green. `tsc` catches any field the handler still reads that the schema does not declare.

- [ ] **Step 10: Exercise the real UI**

Run `cd web && npm run dev` and, signed in as admin: change a finding's remediation status on `/reports`, create and then delete a schedule on `/settings`, and set then clear a monthly budget on `/cost`. Each must still work. This is the step that catches a schema stricter than the UI's actual payload — `.strict()` rejects any field the form sends that the schema forgot.

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/package-lock.json web/lib/schemas.ts web/lib/schemas.test.ts \
        web/app/api/findings/\[id\]/route.ts web/app/api/schedule/route.ts \
        web/app/api/subscriptions/route.ts
git commit -m "$(cat <<'EOF'
feat(api): validate mutating request bodies with zod schemas

Strict schemas reject undeclared fields, so a handler that reads two columns
can no longer be handed a third. Replaces per-route ad hoc checks.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Audit log of privileged actions (roadmap §5 item 7)

Nothing currently records who triggered a scan, changed a schedule, mutated a finding, or changed a user's role. Without it there is no incident response — after the C1/C2 window, there is no way to tell whether anything was actually abused.

**Files:**
- Modify: `web/lib/db.ts` — add `audit_log` to `initSchema()`
- Create: `web/lib/audit-log.ts`
- Create: `web/lib/audit-log.test.ts`
- Modify: `web/app/api/audits/run/route.ts`
- Modify: `web/app/api/schedule/route.ts` (POST, PATCH, DELETE)
- Modify: `web/app/api/subscriptions/route.ts` (POST, PATCH)
- Modify: `web/app/api/findings/[id]/route.ts` (PATCH)
- Modify: `web/app/api/auth/users/route.ts` (PATCH, DELETE)
- Modify: `web/app/api/admin/users/route.ts` (PATCH, DELETE)
- Modify: `web/app/api/cost/hetzner/backfill/route.ts` (POST)

**Interfaces:**
- Consumes: `getDB()`, `getVerifiedIdentity`, `clientIp`.
- Produces: `recordAuditLog(req: NextRequest, action: string, detail?: Record<string, unknown>): Promise<void>` — never throws; `listAuditLog(limit?: number): Promise<AuditLogRow[]>`; `interface AuditLogRow { id: string; actor: string; action: string; detail: string; ip: string; created_at: string }`.

- [ ] **Step 1: Add the table**

In `web/lib/db.ts`, inside `initSchema()`'s DDL block, add:

```sql
    -- Append-only trail of privileged actions. `actor` is the verified
    -- session identity, or '' when the action somehow ran without one — which
    -- is itself worth recording rather than dropping. `detail` is JSON-encoded
    -- context, deliberately free-form because each action carries different
    -- fields and this table is read by people, not joined on.
    CREATE TABLE IF NOT EXISTS audit_log (
      id         TEXT PRIMARY KEY,
      actor      TEXT NOT NULL DEFAULT '',
      action     TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '{}',
      ip         TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON audit_log(actor);
```

- [ ] **Step 2: Write the failing tests**

Create `web/lib/audit-log.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { makeSessionToken } from './auth';
import { recordAuditLog, listAuditLog } from './audit-log';

const SECRET = 'test-session-secret';
const SAVED = { ...process.env };

async function reset() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM audit_log');
}

function signedRequest(email: string, ip = '203.0.113.4') {
  return new NextRequest('http://localhost/api/audits/run', {
    method: 'POST',
    headers: {
      cookie: `btg_identity=${email}; btg_session=${makeSessionToken(SECRET, email)}`,
      'x-forwarded-for': ip,
    },
  });
}

describe('recordAuditLog', () => {
  beforeEach(async () => {
    await reset();
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => { process.env = { ...SAVED }; vi.restoreAllMocks(); });

  it('records the verified actor, the action, the detail and the address', async () => {
    await recordAuditLog(signedRequest('admin@example.com'), 'audits.run', { subscription_id: 'sub-1' });

    const [row] = await listAuditLog();
    expect(row.actor).toBe('admin@example.com');
    expect(row.action).toBe('audits.run');
    expect(JSON.parse(row.detail)).toEqual({ subscription_id: 'sub-1' });
    expect(row.ip).toBe('203.0.113.4');
  });

  it('records an empty actor rather than dropping the entry when the session is unverified', async () => {
    const anon = new NextRequest('http://localhost/api/audits/run', { method: 'POST' });
    await recordAuditLog(anon, 'audits.run');

    const [row] = await listAuditLog();
    expect(row.actor).toBe('');
    expect(row.action).toBe('audits.run');
  });

  it('returns newest first', async () => {
    await recordAuditLog(signedRequest('a@example.com'), 'first');
    await recordAuditLog(signedRequest('b@example.com'), 'second');

    const rows = await listAuditLog();
    expect(rows.map(r => r.action)).toEqual(['second', 'first']);
  });

  it('never throws, so a logging failure cannot fail the action it describes', async () => {
    // Logging is not the point of the request. If the insert fails, the scan
    // still needs to run — the alternative is an outage caused by bookkeeping.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(recordAuditLog(signedRequest('admin@example.com'), 'bad.detail', circular)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd web && npx vitest run lib/audit-log.test.ts`
Expected: FAIL — `Failed to resolve import "./audit-log"`.

- [ ] **Step 4: Implement**

Create `web/lib/audit-log.ts`:

```ts
import { randomUUID } from 'crypto';
import type { NextRequest } from 'next/server';
import { getDB } from './db';
import { getVerifiedIdentity } from './auth';
import { clientIp } from './rate-limit';

export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  detail: string;
  ip: string;
  created_at: string;
}

/** Appends one privileged action to the audit trail.
 *
 * Never throws and never rejects: this is bookkeeping about an action, not
 * the action itself, and a failed insert must not turn a working scan into a
 * 500. Failures go to the server log instead. */
export async function recordAuditLog(
  req: NextRequest,
  action: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    const db = await getDB();
    await db.query(
      `INSERT INTO audit_log (id, actor, action, detail, ip) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), getVerifiedIdentity(req), action, JSON.stringify(detail), clientIp(req)]
    );
  } catch (e) {
    console.error(`[audit-log] failed to record "${action}":`, e);
  }
}

export async function listAuditLog(limit = 200): Promise<AuditLogRow[]> {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT id, actor, action, detail, ip, created_at
     FROM audit_log ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return rows as AuditLogRow[];
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/audit-log.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Call it from every privileged handler**

Add `import { recordAuditLog } from '@/lib/audit-log';` to each file below and insert one call on the success path, after the action has actually been performed. Use exactly these action names so the log is greppable:

| File | Handler | Call |
|---|---|---|
| `audits/run/route.ts` | POST | `await recordAuditLog(req, 'audits.run', { subscription_id, audit_id: auditId, commands });` |
| `schedule/route.ts` | POST | `await recordAuditLog(req, 'schedule.create', { id, name, frequency, hour, times_per_day: timesPerDay });` |
| `schedule/route.ts` | PATCH | `await recordAuditLog(req, 'schedule.toggle', { id, enabled: enabled ? 1 : 0 });` |
| `schedule/route.ts` | DELETE | `await recordAuditLog(req, 'schedule.delete', { id });` |
| `subscriptions/route.ts` | POST | `await recordAuditLog(req, 'subscription.create', { id: sub.id, name: sub.name });` |
| `subscriptions/route.ts` | PATCH | `await recordAuditLog(req, 'subscription.budget', { id: parsed.data.id, monthly_budget: monthlyBudget });` |
| `findings/[id]/route.ts` | PATCH | `await recordAuditLog(req, 'finding.update', { id: params.id, remediation_status, support_ticket_ref });` |
| `auth/users/route.ts` | PATCH | `await recordAuditLog(req, 'user.status', { id, status });` |
| `auth/users/route.ts` | DELETE | `await recordAuditLog(req, 'user.delete', { id });` |
| `admin/users/route.ts` | PATCH | `await recordAuditLog(req, 'user.update', { id, status, role });` |
| `admin/users/route.ts` | DELETE | `await recordAuditLog(req, 'user.delete', { id });` |
| `cost/hetzner/backfill/route.ts` | POST | `await recordAuditLog(req, 'hetzner.backfill', { days, reconstructed: points.length });` |

Never log a secret. `subscription.create` records the id and name only — not `client_secret`.

- [ ] **Step 7: Run everything**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean and green.

- [ ] **Step 8: Verify end to end**

Run `cd web && npm run dev`, sign in as admin, toggle a schedule off and on, then run:

```bash
psql "$DATABASE_URL" -c "SELECT actor, action, detail, ip, created_at FROM audit_log ORDER BY created_at DESC LIMIT 10;"
```

Expected: two `schedule.toggle` rows naming your admin email. If `actor` is empty, `getVerifiedIdentity` is not seeing the cookie — check that the handler passes the same `req` it received.

- [ ] **Step 9: Commit**

```bash
git add web/lib/db.ts web/lib/audit-log.ts web/lib/audit-log.test.ts web/app/api
git commit -m "$(cat <<'EOF'
feat(api): record privileged actions to an audit_log table

Scans, schedule changes, finding mutations, user role/status changes and
backfills now record who did what from where. Logging never fails the action
it describes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- [ ] `cd web && npm test` — green
- [ ] `cd web && npx tsc --noEmit` — clean
- [ ] `cd web && npm run build` — succeeds
- [ ] `grep -rn "(e as Error).message" web/app/api` returns nothing
- [ ] A burst of 12 logins from one address returns 429 for the last two, with `Retry-After`
- [ ] `GET /api/audits` still answers 200 on the 200th consecutive poll (the scheduled workflow's pattern)
- [ ] `SELECT COUNT(*) FROM audit_log` is non-zero after exercising the admin UI
