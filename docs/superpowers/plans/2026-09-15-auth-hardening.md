# Auth & Session Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close H1, H3, M1 and L1 from the security review — make OTPs cryptographically random, move OTP and attempt state into Postgres so throttling survives restarts and multiple instances, refuse to issue a session when `SESSION_SECRET` is unset, stop leaking the OTP in HTTP responses, and mark cookies `Secure` in production.

**Architecture:** The in-memory `Map` behind `web/lib/otp-store.ts` is replaced with an `otp_codes` table, keyed by email, holding a SHA-256 hash of the code rather than the code itself. Attempt counting becomes a single atomic `UPDATE ... RETURNING`, which is what actually fixes the bypass — two concurrent guesses can no longer both read `attempts < 3`. `SESSION_SECRET` loses its hardcoded fallback in all three places that use one, and cookie options move to one shared helper.

**Tech Stack:** Next.js 14 App Router + TypeScript, PostgreSQL via `pg`, vitest against a real `btg_devops_test` database (see `web/vitest.config.ts`).

**Spec:** `docs/security-static-review-2026-09.md` — findings H1, H3, M1, L1.

## Global Constraints

- **Node's `crypto` module only in Node runtime.** `web/middleware.ts` runs in the Edge runtime and must **never** import from `web/lib/auth.ts` or `web/lib/db.ts` — both pull in `node:crypto` / `pg`, which do not exist there. Middleware keeps its own inline Web Crypto implementation.
- **Tests run against a real Postgres test database.** Every db-touching test must first assert `current_database()` ends in `_test` — copy the `assertTestDatabase` guard from `web/lib/db.test.ts`. Never point tests at the dev database.
- **New tables go in `initSchema()` in `web/lib/db.ts`**, inside the existing `CREATE TABLE IF NOT EXISTS` block. New *columns* on existing tables must additionally be added to the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block below it — that file documents this rule at line ~216; follow it.
- **`vitest.config.ts` sets `fileParallelism: false`.** Test files share one physical database. Do not re-enable parallelism.
- **Do not change OTP UX semantics:** 6 digits, 5-minute TTL, 3 attempts, one live code per email (a resend replaces the previous code).
- Run `cd web && npm test` and `cd web && npx tsc --noEmit` before every commit.

---

### Task 1: OTP uses a CSPRNG (H1)

The current generator is `Math.floor(100000 + Math.random() * 900000)`. Two problems: `Math.random()` is not a CSPRNG, and the `100000 +` offset means a code can never start with `0` — the keyspace is 900,000, not 1,000,000.

**Files:**
- Modify: `web/lib/otp-store.ts:16-18`
- Test: `web/lib/otp-store.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `generateOTP(): string` — unchanged signature, still exactly 6 characters, now able to return codes with leading zeros.

- [ ] **Step 1: Write the failing test**

Create `web/lib/otp-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateOTP } from './otp-store';

describe('generateOTP', () => {
  it('always returns exactly 6 digits', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateOTP()).toMatch(/^\d{6}$/);
    }
  });

  it('can produce codes that start with 0', () => {
    // The regression: `100000 + Math.random() * 900000` could never emit a
    // leading zero, so the real keyspace was 900,000 rather than 1,000,000.
    // With a uniform draw over [0, 1e6) the chance of seeing no leading zero
    // in 500 draws is 0.9^500 — about 1 in 10^23.
    const codes = Array.from({ length: 500 }, () => generateOTP());
    expect(codes.some(c => c.startsWith('0'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd web && npx vitest run lib/otp-store.test.ts`
Expected: the `/^\d{6}$/` test PASSES, the leading-zero test FAILS with `expected false to be true`.

- [ ] **Step 3: Implement**

In `web/lib/otp-store.ts`, add the import at the top of the file:

```ts
import { randomInt } from 'crypto';
```

and replace `generateOTP`:

```ts
export function generateOTP(): string {
  // randomInt is a CSPRNG and the range is the full 6-digit space including
  // codes with leading zeros, which padStart preserves.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd web && npx vitest run lib/otp-store.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd web && npm test`
Expected: all green. No other test asserts on OTP values.

- [ ] **Step 6: Commit**

```bash
git add web/lib/otp-store.ts web/lib/otp-store.test.ts
git commit -m "$(cat <<'EOF'
fix(auth): generate OTPs with a CSPRNG over the full 6-digit space

Math.random() is not cryptographically secure, and the 100000+ offset
excluded every code with a leading zero — a 900k keyspace presented as 1M.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Move OTP and attempt state into Postgres (H3)

A per-process `Map` means a code issued by one instance cannot be verified by another, and each instance keeps its own attempt counter — so the 3-attempt lockout is per instance, and spreading guesses across instances defeats it. It also resets on every restart.

**Files:**
- Modify: `web/lib/db.ts` — add `otp_codes` to `initSchema()`
- Modify: `web/lib/otp-store.ts` — full rewrite of the store
- Modify: `web/app/api/auth/login/route.ts:59` — `await createOTP(...)`
- Modify: `web/app/api/auth/resend-otp/route.ts:12` — `await createOTP(...)`
- Modify: `web/app/api/auth/verify-otp/route.ts:23` — `await verifyOTP(...)`
- Test: `web/lib/otp-store.test.ts` (extend)

**Interfaces:**
- Consumes: `getDB()` from `web/lib/db.ts`.
- Produces — all three become `async`, which is the breaking change callers must absorb:
  - `createOTP(email: string): Promise<string>`
  - `verifyOTP(email: string, code: string): Promise<VerifyResult>`
  - `clearOTP(email: string): Promise<void>`
  - `type VerifyResult = 'ok' | 'expired' | 'invalid' | 'locked'` (unchanged)
  - `generateOTP(): string` stays synchronous.

- [ ] **Step 1: Add the table to the schema**

In `web/lib/db.ts`, inside the big `pool.query(\`...\`)` DDL block in `initSchema()`, after the `users` table definition, add:

```sql
    -- One live OTP per email; a resend replaces the previous row rather than
    -- adding another. Holds a SHA-256 of the code, never the code itself —
    -- an OTP is a credential, and this table is readable by anything with a
    -- database connection. `attempts` lives here rather than in process
    -- memory so the 3-strike lockout is global: a single atomic
    -- UPDATE ... RETURNING claims an attempt, so two concurrent guesses (or
    -- two app instances) cannot both observe attempts < MAX and slip past.
    CREATE TABLE IF NOT EXISTS otp_codes (
      email      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    );
```

- [ ] **Step 2: Write the failing tests**

Append to `web/lib/otp-store.test.ts` (and extend the import on line 2 to `import { generateOTP, createOTP, verifyOTP, clearOTP } from './otp-store';`, adding `beforeEach` to the vitest import):

```ts
import { getDB } from './db';

async function resetOtpTable() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM otp_codes');
}

describe('OTP store — shared, atomic, hashed', () => {
  beforeEach(resetOtpTable);

  it('verifies a code that was issued', async () => {
    const otp = await createOTP('user@example.com');
    expect(await verifyOTP('user@example.com', otp)).toBe('ok');
  });

  it('never stores the code in plaintext', async () => {
    const otp = await createOTP('user@example.com');
    const db = await getDB();
    const { rows } = await db.query('SELECT code_hash FROM otp_codes WHERE email = $1', ['user@example.com']);
    expect(rows[0].code_hash).not.toBe(otp);
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('consumes the code — the same one cannot be replayed', async () => {
    const otp = await createOTP('user@example.com');
    expect(await verifyOTP('user@example.com', otp)).toBe('ok');
    expect(await verifyOTP('user@example.com', otp)).toBe('expired');
  });

  it('is case-insensitive on the email, as the login flow assumes', async () => {
    const otp = await createOTP('User@Example.com');
    expect(await verifyOTP('user@example.com', otp)).toBe('ok');
  });

  it('locks out after 3 wrong guesses', async () => {
    await createOTP('user@example.com');
    expect(await verifyOTP('user@example.com', '000000')).toBe('invalid');
    expect(await verifyOTP('user@example.com', '000001')).toBe('invalid');
    expect(await verifyOTP('user@example.com', '000002')).toBe('locked');
  });

  it('stays locked out even for the correct code', async () => {
    const otp = await createOTP('user@example.com');
    for (let i = 0; i < 3; i++) await verifyOTP('user@example.com', '999999');
    expect(await verifyOTP('user@example.com', otp)).toBe('locked');
  });

  it('counts attempts atomically, so concurrent guesses cannot exceed the limit', async () => {
    // The H3 regression, expressed as a race: with a per-process counter,
    // ten parallel guesses all read attempts=0 and all return 'invalid'.
    // With the atomic UPDATE, only the first three can.
    await createOTP('user@example.com');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => verifyOTP('user@example.com', String(100000 + i)))
    );
    expect(results.filter(r => r === 'invalid').length).toBeLessThanOrEqual(2);
    expect(results.filter(r => r === 'locked').length).toBeGreaterThanOrEqual(8);
  });

  it('treats an expired code as expired and clears it', async () => {
    await createOTP('user@example.com');
    const db = await getDB();
    await db.query(`UPDATE otp_codes SET expires_at = now() - interval '1 second' WHERE email = $1`, ['user@example.com']);
    expect(await verifyOTP('user@example.com', '123456')).toBe('expired');
    const { rows } = await db.query('SELECT 1 FROM otp_codes WHERE email = $1', ['user@example.com']);
    expect(rows).toHaveLength(0);
  });

  it('a resend replaces the previous code and resets the attempt counter', async () => {
    const first = await createOTP('user@example.com');
    await verifyOTP('user@example.com', '000000');
    await verifyOTP('user@example.com', '000001');
    const second = await createOTP('user@example.com');

    expect(await verifyOTP('user@example.com', first)).toBe('invalid');
    expect(await verifyOTP('user@example.com', second)).toBe('ok');
  });

  it('clearOTP removes the row', async () => {
    await createOTP('user@example.com');
    await clearOTP('user@example.com');
    expect(await verifyOTP('user@example.com', '123456')).toBe('expired');
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd web && npx vitest run lib/otp-store.test.ts`
Expected: FAIL. The store is still synchronous, so `await createOTP(...)` returns a string (not a promise of one) but no `otp_codes` row is ever written — the "never stores the code in plaintext" test fails on `rows[0]` being `undefined`, and the atomicity test fails.

- [ ] **Step 4: Rewrite the store**

Replace the entire contents of `web/lib/otp-store.ts` with:

```ts
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { getDB } from './db';

const TTL_MS       = 5 * 60 * 1000;  // 5 minutes
const MAX_ATTEMPTS = 3;

export function generateOTP(): string {
  // randomInt is a CSPRNG and the range is the full 6-digit space including
  // codes with leading zeros, which padStart preserves.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** A plain SHA-256 is the right primitive here, not scrypt: the input has
 * only 10^6 possibilities, so no KDF makes it brute-force-resistant offline.
 * What this buys is that a database dump does not hand over live codes, and
 * the 5-minute TTL plus the 3-attempt lockout do the actual work. */
function hashOTP(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function createOTP(email: string): Promise<string> {
  const otp = generateOTP();
  const db = await getDB();

  // Opportunistic GC — cheap, indexed by the primary key, and saves needing
  // a scheduled job for a table that holds at most one row per pending login.
  await db.query('DELETE FROM otp_codes WHERE expires_at < now()');

  await db.query(
    `INSERT INTO otp_codes (email, code_hash, expires_at, attempts)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, 0)
     ON CONFLICT (email) DO UPDATE SET
       code_hash  = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts   = 0`,
    [email.toLowerCase(), hashOTP(otp), String(TTL_MS)]
  );
  return otp;
}

export type VerifyResult = 'ok' | 'expired' | 'invalid' | 'locked';

export async function verifyOTP(email: string, code: string): Promise<VerifyResult> {
  const db  = await getDB();
  const key = email.toLowerCase();

  // Claim an attempt and read the row back in ONE statement. This is the
  // whole point of the table: with a per-process counter, two concurrent
  // guesses both read attempts=0, both increment to 1, and the lockout never
  // fires. Here the second guess always observes the first one's increment.
  const { rows } = await db.query(
    `UPDATE otp_codes SET attempts = attempts + 1
     WHERE email = $1
     RETURNING code_hash, attempts, (expires_at <= now()) AS expired`,
    [key]
  );

  const row = rows[0] as { code_hash: string; attempts: number; expired: boolean } | undefined;
  if (!row) return 'expired';   // no row at all — never issued, or already consumed

  if (row.expired) {
    await db.query('DELETE FROM otp_codes WHERE email = $1', [key]);
    return 'expired';
  }
  if (row.attempts > MAX_ATTEMPTS) return 'locked';

  const presented = Buffer.from(hashOTP(code));
  const expected  = Buffer.from(row.code_hash);
  const matches   = presented.length === expected.length && timingSafeEqual(presented, expected);

  if (!matches) {
    return row.attempts >= MAX_ATTEMPTS ? 'locked' : 'invalid';
  }

  await db.query('DELETE FROM otp_codes WHERE email = $1', [key]);
  return 'ok';
}

export async function clearOTP(email: string): Promise<void> {
  const db = await getDB();
  await db.query('DELETE FROM otp_codes WHERE email = $1', [email.toLowerCase()]);
}
```

- [ ] **Step 5: Update the three callers to await**

In `web/app/api/auth/login/route.ts`, find `const otp = createOTP(normalEmail);` and change it to:

```ts
  const otp = await createOTP(normalEmail);
```

In `web/app/api/auth/resend-otp/route.ts`, find `const otp = createOTP(pendingEmail);` and change it to:

```ts
  const otp = await createOTP(pendingEmail);
```

In `web/app/api/auth/verify-otp/route.ts`, find `const result = verifyOTP(pendingEmail, otp);` and change it to:

```ts
  const result = await verifyOTP(pendingEmail, otp);
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/otp-store.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Type-check and run the whole suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean, all green. `tsc` is what catches a missed `await` at a caller — if it reports `Type 'Promise<string>' is not assignable to type 'string'`, a caller in Step 5 was missed.

- [ ] **Step 8: Commit**

```bash
git add web/lib/db.ts web/lib/otp-store.ts web/lib/otp-store.test.ts \
        web/app/api/auth/login/route.ts web/app/api/auth/resend-otp/route.ts \
        web/app/api/auth/verify-otp/route.ts
git commit -m "$(cat <<'EOF'
fix(auth): move OTP and attempt state to Postgres, hashed and atomic

A per-process Map meant the 3-attempt lockout was per instance and reset on
restart, so guesses spread across instances defeated it. Attempts are now
claimed by a single UPDATE ... RETURNING, and the table holds a SHA-256 of
the code rather than the code itself.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Refuse to issue or accept a session without `SESSION_SECRET` (M1, part 1)

`process.env.SESSION_SECRET ?? 'btg-devops-default-secret'` appears in three places. The fallback is in the repository, so anyone can forge a valid `btg_session` for any email against a deployment that forgot to set the variable. `getVerifiedIdentity()` already fails closed on an unset secret — this task closes the three places that still fall back.

**Files:**
- Modify: `web/lib/auth.ts` — add `requireSessionSecret()`
- Modify: `web/app/api/auth/login/route.ts` — the admin-bypass branch
- Modify: `web/app/api/auth/verify-otp/route.ts`
- Modify: `web/middleware.ts:29` — its own inline check
- Modify: `web/app/api/admin/stats/route.ts:70` — the health indicator
- Test: `web/lib/auth.test.ts` (extend), `web/lib/session-secret.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `requireSessionSecret(): string` — returns the secret, throws `Error` when unset. Route handlers catch it and return 500.

- [ ] **Step 1: Write the failing tests**

Create `web/lib/session-secret.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { requireSessionSecret } from './auth';
import { POST as login } from '@/app/api/auth/login/route';

describe('requireSessionSecret', () => {
  const ORIGINAL = process.env.SESSION_SECRET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ORIGINAL;
  });

  it('returns the configured secret', () => {
    process.env.SESSION_SECRET = 'a-real-secret';
    expect(requireSessionSecret()).toBe('a-real-secret');
  });

  it('throws rather than falling back to a hardcoded default', () => {
    delete process.env.SESSION_SECRET;
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it('treats an empty string as unset', () => {
    process.env.SESSION_SECRET = '';
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET/);
  });
});

describe('POST /api/auth/login — admin bypass with no SESSION_SECRET', () => {
  const ORIGINAL_SECRET = process.env.SESSION_SECRET;
  const ORIGINAL_EMAIL  = process.env.ADMIN_EMAIL;
  const ORIGINAL_PASS   = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_EMAIL === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = ORIGINAL_EMAIL;
    if (ORIGINAL_PASS === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = ORIGINAL_PASS;
  });

  it('refuses to authenticate rather than signing with a public default', async () => {
    const res = await login(new NextRequest('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse-battery-staple' }),
    }));

    expect(res.status).toBe(500);
    // And crucially: no session cookie was handed out.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('btg_session');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd web && npx vitest run lib/session-secret.test.ts`
Expected: FAIL — `requireSessionSecret is not a function`, and the login test returns 200 with a `btg_session` cookie signed using the hardcoded default.

- [ ] **Step 3: Add the helper**

In `web/lib/auth.ts`, directly below `makeSessionToken`, add:

```ts
/** The secret used to sign sessions. Throws rather than returning a default:
 * the old `?? 'btg-devops-default-secret'` fallback is committed to this
 * repository, so a deployment that forgot the variable was handing out
 * sessions anyone could forge. A loud 500 at login is the correct failure. */
export function requireSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set — refusing to issue a session');
  }
  return secret;
}
```

- [ ] **Step 4: Use it in the login route**

In `web/app/api/auth/login/route.ts`, update the import to include the helper:

```ts
import { verifyPassword, makeSessionToken, requireSessionSecret } from '@/lib/auth';
```

Then replace the admin-bypass secret line. Find:

```ts
    const secret = process.env.SESSION_SECRET ?? 'btg-devops-default-secret';
    const token  = makeSessionToken(secret, normalEmail);
```

and replace with:

```ts
    let token: string;
    try {
      token = makeSessionToken(requireSessionSecret(), normalEmail);
    } catch (e) {
      console.error('[auth/login]', e);
      return NextResponse.json({ error: 'Server is not configured for sign-in.' }, { status: 500 });
    }
```

- [ ] **Step 5: Use it in the verify-otp route**

In `web/app/api/auth/verify-otp/route.ts`, update the import:

```ts
import { makeSessionToken, requireSessionSecret } from '@/lib/auth';
```

Find:

```ts
  const secret = process.env.SESSION_SECRET ?? 'btg-devops-default-secret';
  const token = makeSessionToken(secret, pendingEmail);
```

and replace with:

```ts
  let token: string;
  try {
    token = makeSessionToken(requireSessionSecret(), pendingEmail);
  } catch (e) {
    console.error('[auth/verify-otp]', e);
    return NextResponse.json({ error: 'Server is not configured for sign-in.' }, { status: 500 });
  }
```

- [ ] **Step 6: Fix the middleware's own fallback**

`web/middleware.ts` runs in the Edge runtime and **must not** import `@/lib/auth` — that module pulls in `node:crypto` and, transitively, `pg`. It keeps its own check. In `web/middleware.ts`, find:

```ts
  const secret   = process.env.SESSION_SECRET ?? 'btg-devops-default-secret';
```

and replace with:

```ts
  // Deliberately not imported from @/lib/auth: this file runs in the Edge
  // runtime, which has no node:crypto and no pg. Same rule as
  // requireSessionSecret() there — an unset secret rejects every request
  // rather than validating tokens against a default anyone can read.
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error('[middleware] SESSION_SECRET is not set — rejecting every authenticated request');
    return NextResponse.redirect(new URL('/login', req.url));
  }
```

- [ ] **Step 7: Simplify the health indicator**

In `web/app/api/admin/stats/route.ts`, the `envChecks` object still tests against the removed default string. Find:

```ts
    sessionSecret: !!(process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'btg-devops-default-secret'),
```

and replace with:

```ts
    sessionSecret: !!process.env.SESSION_SECRET,
```

- [ ] **Step 8: Verify the default string is gone from the codebase**

Run: `cd web && grep -rn "btg-devops-default-secret" lib app middleware.ts || echo "NONE FOUND"`

Expected: `NONE FOUND`. Any remaining hit is a place still trusting the public default.

- [ ] **Step 9: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/session-secret.test.ts && npm test`
Expected: PASS, and the full suite green.

- [ ] **Step 10: Commit**

```bash
git add web/lib/auth.ts web/lib/session-secret.test.ts web/middleware.ts \
        web/app/api/auth/login/route.ts web/app/api/auth/verify-otp/route.ts \
        web/app/api/admin/stats/route.ts
git commit -m "$(cat <<'EOF'
fix(auth): fail closed when SESSION_SECRET is unset

The 'btg-devops-default-secret' fallback is in this repository, so a
deployment that missed the variable was issuing and accepting sessions
anyone could forge. Signing now throws and middleware rejects instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Stop emitting the OTP in the login response (M1, part 2)

When SMTP is unconfigured, `/api/auth/login` returns `devOtp` in the JSON body. `web/app/login/page.tsx:30` then puts it in a query string (`/verify-otp?dev=…`), so the code also lands in browser history, the `Referer` header, and any access log in front of the app. The gate today is "SMTP is not configured", which is a property of the deployment, not of the environment — a production instance with broken SMTP settings bypasses MFA entirely.

**Files:**
- Modify: `web/app/api/auth/login/route.ts` — the `devOtp` branch
- Modify: `web/.env.local.example` — document the new flag
- Test: `web/lib/dev-otp.test.ts` (create)

**Interfaces:**
- Consumes: `BTG_DEV_OTP` environment variable (new; `'1'` enables).
- Produces: no signature change. The login response contains `devOtp` only when `NODE_ENV !== 'production'` **and** `BTG_DEV_OTP === '1'` **and** SMTP is unconfigured.

- [ ] **Step 1: Write the failing test**

Create `web/lib/dev-otp.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDB } from './db';
import { hashPassword } from './auth';
import { POST as login } from '@/app/api/auth/login/route';

const EMAIL = 'devotp@example.com';
const PASSWORD = 'correct-horse-battery-staple';

async function seedActiveUser() {
  const db = await getDB();
  const { rows } = await db.query('SELECT current_database() as name');
  if (!String(rows[0].name).endsWith('_test')) {
    throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
  }
  await db.query('DELETE FROM otp_codes');
  await db.query('DELETE FROM users');
  await db.query(
    `INSERT INTO users (id, email, name, password_hash, role, status)
     VALUES ('u-devotp', $1, 'Dev OTP', $2, 'viewer', 'active')`,
    [EMAIL, hashPassword(PASSWORD)]
  );
}

function loginRequest() {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
}

describe('POST /api/auth/login — devOtp exposure', () => {
  const SAVED = { ...process.env };

  beforeEach(async () => {
    await seedActiveUser();
    process.env.SESSION_SECRET = 'test-session-secret';
    delete process.env.SMTP_PASS;        // dev mode: no real SMTP
    delete process.env.BTG_DEV_OTP;
  });

  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('does not leak the OTP when BTG_DEV_OTP is not set', async () => {
    const body = await (await login(loginRequest())).json();
    expect(body.devOtp).toBeUndefined();
  });

  it('does not leak the OTP in production even with BTG_DEV_OTP=1', async () => {
    process.env.BTG_DEV_OTP = '1';
    const saved = process.env.NODE_ENV;
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });
    try {
      const body = await (await login(loginRequest())).json();
      expect(body.devOtp).toBeUndefined();
    } finally {
      Object.defineProperty(process.env, 'NODE_ENV', { value: saved, configurable: true });
    }
  });

  it('still surfaces the OTP for local development when explicitly opted in', async () => {
    process.env.BTG_DEV_OTP = '1';
    const body = await (await login(loginRequest())).json();
    expect(body.devOtp).toMatch(/^\d{6}$/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd web && npx vitest run lib/dev-otp.test.ts`
Expected: the first two tests FAIL — `devOtp` is present because the only condition today is `devMode`.

- [ ] **Step 3: Implement the gate**

In `web/app/api/auth/login/route.ts`, find:

```ts
  // In dev mode (no real SMTP) surface the OTP in the response so the UI can show it
  const payload: Record<string, unknown> = { ok: true, skipOtp: false };
  if (devMode) payload.devOtp = otp;
```

and replace with:

```ts
  // Surfacing the OTP in the response bypasses MFA for anyone who can see
  // that response — and web/app/login/page.tsx forwards it as a query
  // parameter, so it reaches browser history, Referer headers and access
  // logs too. "SMTP is unconfigured" is a property of the deployment, not
  // of the environment, so it is not a safe gate on its own: a production
  // instance with broken SMTP credentials would hand out the code. Both an
  // explicit opt-in and a non-production build are now required.
  const allowDevOtp = process.env.NODE_ENV !== 'production' && process.env.BTG_DEV_OTP === '1';
  const payload: Record<string, unknown> = { ok: true, skipOtp: false };
  if (devMode && allowDevOtp) payload.devOtp = otp;
```

- [ ] **Step 4: Document the flag**

In `web/.env.local.example`, below the `SESSION_SECRET` block, add:

```
# Local development only: set to 1 to have /api/auth/login return the OTP in
# its response so you can sign in without SMTP configured. Ignored entirely
# when NODE_ENV=production. Never set this on a deployed instance — it is a
# complete MFA bypass for anyone who can read the response.
BTG_DEV_OTP=0
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/dev-otp.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Confirm the UI degrades cleanly**

`web/app/login/page.tsx:30` reads `if (data.devOtp) params.set('dev', data.devOtp)` and `web/app/verify-otp/page.tsx:170` renders the hint only when `dev` is present. With `devOtp` absent, the parameter is simply never set and the hint block does not render — no code change needed there. Verify by reading both lines and confirming the guards are truthiness checks, not assumptions that the value exists.

- [ ] **Step 7: Run the whole suite and commit**

Run: `cd web && npx tsc --noEmit && npm test`

```bash
git add web/app/api/auth/login/route.ts web/.env.local.example web/lib/dev-otp.test.ts
git commit -m "$(cat <<'EOF'
fix(auth): require an explicit opt-in before returning the OTP in a response

"SMTP is unconfigured" described the deployment, not the environment — a
production instance with broken SMTP credentials would have handed the code
straight back to the caller. Now needs NODE_ENV!=production AND BTG_DEV_OTP=1.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Mark cookies `Secure` in production (L1)

`httpOnly` and `sameSite: 'lax'` are set, but without `secure: true` the session cookie will travel over plain HTTP if the app is ever reached without TLS. The flag cannot be unconditional — local development runs on `http://localhost:3000`, where a `Secure` cookie is dropped by the browser and login silently fails.

**Files:**
- Modify: `web/lib/auth.ts` — add `sessionCookieOptions()`
- Modify: `web/app/api/auth/login/route.ts` — both `cookies.set` calls
- Modify: `web/app/api/auth/verify-otp/route.ts` — all three `cookies.set` calls
- Modify: `web/app/api/auth/logout/route.ts`
- Test: `web/lib/cookie-options.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sessionCookieOptions(maxAgeSeconds: number): { httpOnly: true; sameSite: 'lax'; secure: boolean; maxAge: number; path: '/' }` — a function, not a constant, so `NODE_ENV` is read at call time and tests can flip it.

- [ ] **Step 1: Write the failing test**

Create `web/lib/cookie-options.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { sessionCookieOptions } from './auth';

function withNodeEnv(value: string, fn: () => void) {
  const saved = process.env.NODE_ENV;
  Object.defineProperty(process.env, 'NODE_ENV', { value, configurable: true });
  try { fn(); } finally {
    Object.defineProperty(process.env, 'NODE_ENV', { value: saved, configurable: true });
  }
}

describe('sessionCookieOptions', () => {
  it('sets Secure in production', () => {
    withNodeEnv('production', () => {
      expect(sessionCookieOptions(3600).secure).toBe(true);
    });
  });

  it('does not set Secure in development, where the app runs on plain http', () => {
    // A Secure cookie is dropped by the browser on http://localhost, which
    // would make local login fail with no visible error.
    withNodeEnv('development', () => {
      expect(sessionCookieOptions(3600).secure).toBe(false);
    });
  });

  it('keeps httpOnly, SameSite=Lax, path=/ and the requested maxAge', () => {
    const opts = sessionCookieOptions(28800);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(28800);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd web && npx vitest run lib/cookie-options.test.ts`
Expected: FAIL with `sessionCookieOptions is not a function`.

- [ ] **Step 3: Add the helper**

In `web/lib/auth.ts`, below `requireSessionSecret()`, add:

```ts
/** Shared options for every auth cookie this app sets.
 *
 * `secure` is conditional rather than always true because local development
 * serves plain http://localhost, where a Secure cookie is silently dropped
 * and login appears to succeed while no session is ever stored. A function
 * rather than a constant so NODE_ENV is read per call. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeSeconds,
    path: '/' as const,
  };
}
```

- [ ] **Step 4: Use it in the login route**

In `web/app/api/auth/login/route.ts`, extend the import:

```ts
import { verifyPassword, makeSessionToken, requireSessionSecret, sessionCookieOptions } from '@/lib/auth';
```

Replace the two admin-branch cookie writes. Find:

```ts
    res.cookies.set('btg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
    res.cookies.set('btg_identity', normalEmail, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
```

with:

```ts
    res.cookies.set('btg_session', token, sessionCookieOptions(60 * 60 * 8));
    res.cookies.set('btg_identity', normalEmail, sessionCookieOptions(60 * 60 * 8));
```

Then find the pending-OTP cookie:

```ts
  res.cookies.set('btg_otp_pending', normalEmail, {
    httpOnly: true, sameSite: 'lax', maxAge: 60 * 10, path: '/',
  });
```

and replace with:

```ts
  res.cookies.set('btg_otp_pending', normalEmail, sessionCookieOptions(60 * 10));
```

- [ ] **Step 5: Use it in the verify-otp route**

In `web/app/api/auth/verify-otp/route.ts`, extend the import:

```ts
import { makeSessionToken, requireSessionSecret, sessionCookieOptions } from '@/lib/auth';
```

Find:

```ts
  res.cookies.set('btg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
  res.cookies.set('btg_identity', pendingEmail, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 8, path: '/' });
  res.cookies.set('btg_otp_pending', '', { maxAge: 0, path: '/' });
```

and replace with:

```ts
  res.cookies.set('btg_session', token, sessionCookieOptions(60 * 60 * 8));
  res.cookies.set('btg_identity', pendingEmail, sessionCookieOptions(60 * 60 * 8));
  res.cookies.set('btg_otp_pending', '', sessionCookieOptions(0));
```

- [ ] **Step 6: Clear both cookies on logout**

`web/app/api/auth/logout/route.ts` currently clears only `btg_session`, leaving `btg_identity` in the browser. That is not exploitable now that the session HMAC is verified, but it leaves a stale identity cookie that makes debugging confusing. Replace the whole file with:

```ts
import { NextResponse } from 'next/server';
import { sessionCookieOptions } from '@/lib/auth';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Clear both halves of the session. Leaving btg_identity behind is not
  // exploitable — nothing trusts it without a matching btg_session — but a
  // stale identity cookie makes "am I logged out?" needlessly ambiguous.
  res.cookies.set('btg_session', '', sessionCookieOptions(0));
  res.cookies.set('btg_identity', '', sessionCookieOptions(0));
  res.cookies.set('btg_otp_pending', '', sessionCookieOptions(0));
  return res;
}
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/cookie-options.test.ts && npm test`
Expected: PASS, and the full suite green.

- [ ] **Step 8: Verify the real login flow still works locally**

Run: `cd web && npm run dev`, open `http://localhost:3000/login`, and sign in as the `ADMIN_EMAIL` account. Confirm you land on `/dashboard` and that DevTools → Application → Cookies shows `btg_session` and `btg_identity` present with `Secure` **unchecked** (development). Stop the dev server when done.

This is the step that catches a `Secure`-in-development regression, which no unit test can see.

- [ ] **Step 9: Commit**

```bash
git add web/lib/auth.ts web/lib/cookie-options.test.ts \
        web/app/api/auth/login/route.ts web/app/api/auth/verify-otp/route.ts \
        web/app/api/auth/logout/route.ts
git commit -m "$(cat <<'EOF'
fix(auth): centralise cookie options and set Secure in production

Session cookies could ride over plain HTTP if the app were ever reached
without TLS. Secure is conditional on NODE_ENV so local http development
still works, and logout now clears every auth cookie rather than one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- [ ] `cd web && npm test` — green
- [ ] `cd web && npx tsc --noEmit` — clean
- [ ] `cd web && npm run build` — succeeds
- [ ] Project-wide search for `btg-devops-default-secret` returns nothing
- [ ] Project-wide search for `Math.random` in `web/lib` and `web/app/api` returns nothing
- [ ] A manual login against `npm run dev` succeeds and issues both cookies
