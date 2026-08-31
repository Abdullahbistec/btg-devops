import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vitest/config';

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
    env: {
      DATABASE_URL: testDatabaseUrl(),
    },
  },
});
