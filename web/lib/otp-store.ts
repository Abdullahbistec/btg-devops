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
