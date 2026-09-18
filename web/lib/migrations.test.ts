import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, MIGRATIONS } from './migrations';

// Uses the same dedicated btg_devops_test database the rest of the db suite
// does (DATABASE_URL is injected by vitest.config.ts). getDB() elsewhere has
// already created the baseline schema; here we drive the migration runner
// directly to assert the ledger, ordering, and idempotency.
const CONN = process.env.DATABASE_URL;

describe.skipIf(!CONN)('migration runner', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONN });
    // Ensure the tables a migration touches exist (baseline is normally
    // applied by getDB; create the minimum here so this test is standalone).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY, service TEXT, severity TEXT, remediation_status TEXT
      );
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies pending migrations and records them in schema_migrations', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const recorded = rows.map((r: { version: string }) => r.version);
    for (const m of MIGRATIONS) {
      expect(recorded).toContain(m.version);
    }
  });

  it('is idempotent — a second run applies nothing', async () => {
    const ran = await runMigrations(pool);
    expect(ran).toEqual([]);
  });

  it('created the findings indexes from 0001', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'findings'`
    );
    const names = rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain('idx_findings_service');
    expect(names).toContain('idx_findings_remediation');
  });

  it('migration versions are unique and lexically ordered', () => {
    const versions = MIGRATIONS.map(m => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a.localeCompare(b))).toEqual(versions);
  });
});
