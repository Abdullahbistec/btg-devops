import fs from 'fs';
import path from 'path';
import { defineConfig, configDefaults } from 'vitest/config';

/** Derives a connection string for the dedicated btg_devops_test database
 * from whatever DATABASE_URL is configured in .env.local — same host,
 * user, and password, different database name. Never hardcodes a
 * credential here; if .env.local has no DATABASE_URL yet, db-touching
 * tests fail with a clear message instead of silently running against
 * nothing (or, worse, the real dev database). */
function testDatabaseUrl(): string {
  const envPath = path.resolve(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return '';
  const match = fs.readFileSync(envPath, 'utf8').match(/^DATABASE_URL=(.+)$/m);
  if (!match) return '';
  const url = new URL(match[1].trim());
  url.pathname = '/btg_devops_test';
  return url.toString();
}

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./*"] — vitest doesn't read tsconfig
    // paths on its own, so any test whose module (transitively) imports
    // via "@/..." fails to resolve without this.
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    // e2e/ holds Playwright specs (browser E2E), run via `npx playwright test`,
    // not vitest — they import @playwright/test and must not be picked up here.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    env: {
      DATABASE_URL: testDatabaseUrl(),
    },
    // Every db-touching test file shares one physical Postgres database, and
    // they set up by DELETEing the tables they use (db.pool.test.ts goes
    // further and drops a column, then mutates DATABASE_URL). Run in
    // parallel, those files corrupt each other's fixtures and the suite fails
    // in a different place on every run. Postgres has no per-worker
    // in-memory-database equivalent to the old SQLite setup, so the fix is to
    // serialise the files. The whole suite runs in ~2s; determinism is worth
    // far more than the parallelism here.
    fileParallelism: false,
  },
});
