import type { Pool, PoolClient } from 'pg';

/**
 * Versioned, once-applied schema migrations.
 *
 * This runs AFTER `initSchema()` in db.ts. initSchema stays the idempotent
 * baseline (CREATE TABLE / ADD COLUMN IF NOT EXISTS) that guarantees a fresh
 * database has every table and column; this file is for changes that a
 * re-runnable baseline cannot express — altering a column's type, backfilling
 * data, renaming, dropping — where "run exactly once, in order, and record
 * that it ran" is the only safe contract.
 *
 * Rules:
 *  - Add a NEW entry to MIGRATIONS for each change; give it the next ordinal.
 *  - NEVER edit or reorder an already-shipped migration — its version is
 *    recorded in schema_migrations and it will not run again. Fix a mistake
 *    with a new migration.
 *  - Each `up` runs inside a transaction on the passed client; throw to roll
 *    the whole migration back (nothing is recorded, the next boot retries).
 *  - A session-level advisory lock serialises the whole run, so multiple app
 *    instances booting at once migrate exactly once between them rather than
 *    racing (this is also the seam for the scheduler's multi-instance lock —
 *    see docs/backend-engineering-review E-4).
 */
export interface Migration {
  version: string; // ordered lexically, e.g. '0001_findings_indexes'
  up: (client: PoolClient) => Promise<void>;
}

// Arbitrary fixed key so only one process migrates at a time.
const MIGRATION_LOCK_KEY = 727314;

export const MIGRATIONS: Migration[] = [
  {
    // findings is filtered by service (scope IN/NOT IN lists) and by
    // remediation_status on the list route, but the baseline only indexed
    // audit_id and severity. These are plain CREATE INDEX IF NOT EXISTS —
    // no table rewrite, safe on a populated table.
    version: '0001_findings_indexes',
    up: async (c) => {
      await c.query(`CREATE INDEX IF NOT EXISTS idx_findings_service     ON findings(service);`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_findings_remediation ON findings(remediation_status);`);
    },
  },
];

/** Applies every migration not yet recorded in schema_migrations, in order,
 * each in its own transaction. Returns the versions applied this run (empty
 * when the database is already up to date). Safe to call on every boot. */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set<string>(rows.map((r: { version: string }) => r.version));

    const ordered = [...MIGRATIONS].sort((a, b) => a.version.localeCompare(b.version));
    const ran: string[] = [];

    for (const m of ordered) {
      if (applied.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await m.up(client);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
        await client.query('COMMIT');
        ran.push(m.version);
        console.log(`[migrations] applied ${m.version}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`[migrations] ${m.version} failed and was rolled back: ${(e as Error).message}`);
      }
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
