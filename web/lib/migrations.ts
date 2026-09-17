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
  {
    // INTEGER 0/1 flags → real boolean (E-7). Guarded so it is a no-op if the
    // column is already boolean (fresh DB whose baseline shipped boolean, or a
    // re-run), and only converts a column that is still integer. USING (x <> 0)
    // maps 1→true, 0→false.
    version: '0002_boolean_flags',
    up: async (c) => {
      await c.query(`
        DO $$
        BEGIN
          IF (SELECT data_type FROM information_schema.columns
              WHERE table_name = 'subscriptions' AND column_name = 'is_active') = 'integer' THEN
            ALTER TABLE subscriptions ALTER COLUMN is_active DROP DEFAULT;
            ALTER TABLE subscriptions ALTER COLUMN is_active TYPE boolean USING (is_active <> 0);
            ALTER TABLE subscriptions ALTER COLUMN is_active SET DEFAULT true;
          END IF;
          IF (SELECT data_type FROM information_schema.columns
              WHERE table_name = 'schedules' AND column_name = 'enabled') = 'integer' THEN
            ALTER TABLE schedules ALTER COLUMN enabled DROP DEFAULT;
            ALTER TABLE schedules ALTER COLUMN enabled TYPE boolean USING (enabled <> 0);
            ALTER TABLE schedules ALTER COLUMN enabled SET DEFAULT true;
          END IF;
        END $$;
      `);
    },
  },
  {
    // JSON-in-TEXT columns → jsonb (E-5): validation on write + queryability.
    // Guarded per column (no-op if already jsonb); the USING maps an empty or
    // whitespace value to '[]' so the cast can never abort on a stray blank row
    // — every real value was written via JSON.stringify and is valid JSON.
    // Writes keep passing JSON.stringify(...) (a JSON string binds to jsonb);
    // reads now get parsed objects, so JSON.parse was removed at the read sites.
    version: '0003_jsonb_columns',
    up: async (c) => {
      await c.query(`
        DO $$
        BEGIN
          IF (SELECT data_type FROM information_schema.columns WHERE table_name='audits' AND column_name='commands_run')='text' THEN
            ALTER TABLE audits ALTER COLUMN commands_run DROP DEFAULT;
            ALTER TABLE audits ALTER COLUMN commands_run TYPE jsonb USING (CASE WHEN btrim(coalesce(commands_run,''))='' THEN '[]' ELSE commands_run END::jsonb);
            ALTER TABLE audits ALTER COLUMN commands_run SET DEFAULT '[]'::jsonb;
          END IF;
          IF (SELECT data_type FROM information_schema.columns WHERE table_name='cost_snapshots' AND column_name='by_service')='text' THEN
            ALTER TABLE cost_snapshots ALTER COLUMN by_service DROP DEFAULT;
            ALTER TABLE cost_snapshots ALTER COLUMN by_service TYPE jsonb USING (CASE WHEN btrim(coalesce(by_service,''))='' THEN '[]' ELSE by_service END::jsonb);
            ALTER TABLE cost_snapshots ALTER COLUMN by_service SET DEFAULT '[]'::jsonb;
          END IF;
          IF (SELECT data_type FROM information_schema.columns WHERE table_name='cost_snapshots' AND column_name='by_resource_group')='text' THEN
            ALTER TABLE cost_snapshots ALTER COLUMN by_resource_group DROP DEFAULT;
            ALTER TABLE cost_snapshots ALTER COLUMN by_resource_group TYPE jsonb USING (CASE WHEN btrim(coalesce(by_resource_group,''))='' THEN '[]' ELSE by_resource_group END::jsonb);
            ALTER TABLE cost_snapshots ALTER COLUMN by_resource_group SET DEFAULT '[]'::jsonb;
          END IF;
          IF (SELECT data_type FROM information_schema.columns WHERE table_name='cost_snapshot_history' AND column_name='by_service')='text' THEN
            ALTER TABLE cost_snapshot_history ALTER COLUMN by_service TYPE jsonb USING (CASE WHEN btrim(coalesce(by_service,''))='' THEN '[]' ELSE by_service END::jsonb);
          END IF;
          IF (SELECT data_type FROM information_schema.columns WHERE table_name='hetzner_cost_snapshots' AND column_name='by_category')='text' THEN
            ALTER TABLE hetzner_cost_snapshots ALTER COLUMN by_category TYPE jsonb USING (CASE WHEN btrim(coalesce(by_category,''))='' THEN '{}' ELSE by_category END::jsonb);
          END IF;
          IF (SELECT data_type FROM information_schema.columns WHERE table_name='hetzner_cost_snapshots' AND column_name='by_type')='text' THEN
            ALTER TABLE hetzner_cost_snapshots ALTER COLUMN by_type TYPE jsonb USING (CASE WHEN btrim(coalesce(by_type,''))='' THEN '{}' ELSE by_type END::jsonb);
          END IF;
          IF (SELECT data_type FROM information_schema.columns WHERE table_name='hetzner_cost_snapshots' AND column_name='unpriced')='text' THEN
            ALTER TABLE hetzner_cost_snapshots ALTER COLUMN unpriced DROP DEFAULT;
            ALTER TABLE hetzner_cost_snapshots ALTER COLUMN unpriced TYPE jsonb USING (CASE WHEN btrim(coalesce(unpriced,''))='' THEN '[]' ELSE unpriced END::jsonb);
            ALTER TABLE hetzner_cost_snapshots ALTER COLUMN unpriced SET DEFAULT '[]'::jsonb;
          END IF;
        END $$;
      `);
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
