import { describe, it, expect, vi, beforeEach } from 'vitest';
import pg from 'pg';

/** Loads a cold copy of ./db — the module-level _pool/_ready cache is reset,
 * so getDB() runs initSchema for real, exactly as a freshly booted process
 * would. These three behaviours are invisible to the query-level tests in
 * db.test.ts (which share one already-initialised pool), and all three
 * regressed silently during the SQLite → Postgres migration. */
async function coldDb() {
  vi.resetModules();
  return await import('./db');
}

const GOOD = process.env.DATABASE_URL!;

describe('getDB pool lifecycle', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = GOOD;
  });

  it('registers an idle-client error listener', async () => {
    // Without one, pg's 'error' event on an idle client (Postgres restart,
    // dropped connection) is an unhandled EventEmitter error that takes the
    // whole Next.js process down.
    const { getDB } = await coldDb();
    const pool = await getDB();
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });

  it('does not cache a failed initialisation', async () => {
    const bad = new URL(GOOD);
    bad.pathname = '/definitely_no_such_database_xyz';
    process.env.DATABASE_URL = bad.toString();

    const { getDB } = await coldDb();
    await expect(getDB()).rejects.toThrow();

    // Same module instance, Postgres now reachable. A cached rejected
    // promise here would mean one transient startup failure (app booting
    // before Postgres accepts connections) breaks the process permanently.
    process.env.DATABASE_URL = GOOD;
    const pool = await getDB();
    const { rows } = await pool.query('SELECT 1 as ok');
    expect(rows[0].ok).toBe(1);
  });
});

describe('initSchema column migrations', () => {
  it('adds a column missing from an already-created database', async () => {
    const probe = new pg.Pool({ connectionString: GOOD });
    const { rows } = await probe.query('SELECT current_database() as name');
    // Same guard as db.test.ts — never mutate a non-test database.
    expect(String(rows[0].name).endsWith('_test')).toBe(true);

    const hasLocation = async () =>
      (await probe.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name='findings' AND column_name='location'`
      )).rowCount;

    // Simulate a database created before `location` entered the DDL. Every
    // CREATE TABLE in initSchema is IF NOT EXISTS, so the DDL alone is a
    // no-op here and the column would stay missing forever.
    await probe.query('ALTER TABLE findings DROP COLUMN IF EXISTS location');
    expect(await hasLocation()).toBe(0);

    const { getDB } = await coldDb();
    await getDB();

    expect(await hasLocation()).toBe(1);
    await probe.end();
  });
});
