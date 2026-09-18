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
