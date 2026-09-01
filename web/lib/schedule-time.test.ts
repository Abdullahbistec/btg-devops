import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { computeNextRun, toUtcTimestamp, NOW_UTC_SQL } from './schedule-time';

describe('computeNextRun', () => {
  it('interprets hour as UTC regardless of the host timezone', () => {
    // The regression: the old implementation used setHours(), which is
    // host-local, then serialised through toISOString(). On this machine
    // (Asia/Colombo, +05:30) "hour 2" became 20:30 UTC the previous day, so
    // the stored next_run_at no longer meant what the UI showed.
    const now = new Date('2026-09-01T00:30:00.000Z');
    expect(computeNextRun('daily', 2, now)).toBe('2026-09-01 02:00:00');
  });

  it('rolls to the next day when the hour has already passed today', () => {
    const now = new Date('2026-09-01T05:00:00.000Z');
    expect(computeNextRun('daily', 2, now)).toBe('2026-09-02 02:00:00');
  });

  it('rolls a week for weekly and a month for monthly', () => {
    const now = new Date('2026-09-01T05:00:00.000Z');
    expect(computeNextRun('weekly', 2, now)).toBe('2026-09-08 02:00:00');
    expect(computeNextRun('monthly', 2, now)).toBe('2026-10-01 02:00:00');
  });

  it('returns an hour boundary exactly, for every hour of the day', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    for (let hour = 0; hour < 24; hour++) {
      const result = computeNextRun('daily', hour, now);
      const utcHour = Number(result.slice(11, 13));
      expect(utcHour).toBe(hour);
      expect(result.slice(13)).toBe(':00:00');
    }
  });
});

describe('toUtcTimestamp', () => {
  it('renders the UTC text form the schedules table stores', () => {
    expect(toUtcTimestamp(new Date('2026-09-01T02:00:00.000Z'))).toBe('2026-09-01 02:00:00');
  });
});

describe('NOW_UTC_SQL', () => {
  it('renders now() in UTC even when the Postgres session timezone is not UTC', async () => {
    // A dedicated pool: SET TIME ZONE persists for the life of a connection,
    // so this must not run on a client the rest of the suite will reuse.
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await pool.query("SET TIME ZONE 'Asia/Colombo'");
      const { rows } = await pool.query(
        `SELECT ${NOW_UTC_SQL} AS utc_now,
                to_char(now(), 'YYYY-MM-DD HH24:MI:SS') AS session_now`
      );

      // What the fix produces: real UTC, matching the clock this app compares
      // against. Within a minute is plenty — this is a clock comparison.
      const expected = toUtcTimestamp(new Date()).slice(0, 16);
      expect(rows[0].utc_now.slice(0, 16)).toBe(expected);

      // And what the old query produced: the session's local wall clock,
      // +05:30 here, which is why schedules fired 5.5 hours early.
      expect(rows[0].session_now).not.toBe(rows[0].utc_now);
    } finally {
      await pool.end();
    }
  });
});
