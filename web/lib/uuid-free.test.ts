import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

describe('the uuid package is not a dependency', () => {
  it('is absent from package.json', () => {
    // uuid <11.1.1 carries GHSA-w5hq-g745-h8pq, and this app only ever needed
    // v4 — which node:crypto provides with no dependency at all.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('uuid');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('@types/uuid');
  });
});

describe('ids are still RFC 4122 v4', () => {
  it('createAudit produces an id of the same shape the old v4() did', async () => {
    const { getDB, createAudit } = await import('./db');
    const db = await getDB();
    const { rows } = await db.query('SELECT current_database() as name');
    if (!String(rows[0].name).endsWith('_test')) {
      throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
    }
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await db.query(
      `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
       VALUES ('sub-uuid-test', 'Test Sub', 'g', 't', 'c')`
    );

    const audit = await createAudit('sub-uuid-test', 'UUID shape check');
    expect(audit.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
