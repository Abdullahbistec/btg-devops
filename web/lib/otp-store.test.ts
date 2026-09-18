import { describe, it, expect, beforeEach } from 'vitest';
import { generateOTP, createOTP, verifyOTP, clearOTP } from './otp-store';
import { getDB } from './db';

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
