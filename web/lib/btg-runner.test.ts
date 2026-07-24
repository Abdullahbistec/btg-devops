/**
 * Unit tests for btg-runner.ts PP credential helpers.
 *
 * Run with: npx vitest run lib/btg-runner.test.ts
 * (add vitest to devDependencies first: npm i -D vitest)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPPCredentials, PP_SERVICE_LABELS } from './btg-runner';

const BASE = {
  tenantId: 'base-tenant',
  clientId: 'base-client',
  clientSecret: 'base-secret',
  subscriptionId: 'base-sub',
};

describe('getPPCredentials', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    ['BTG_PP_TENANT_ID', 'BTG_PP_CLIENT_ID', 'BTG_PP_CLIENT_SECRET'].forEach(k => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(() => {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  it('falls back to base credentials when BTG_PP_* are not set', () => {
    const creds = getPPCredentials(BASE);
    expect(creds).toEqual(BASE);
  });

  it('overrides tenantId when BTG_PP_TENANT_ID is set', () => {
    process.env.BTG_PP_TENANT_ID = 'pp-tenant';
    const creds = getPPCredentials(BASE);
    expect(creds.tenantId).toBe('pp-tenant');
    expect(creds.clientId).toBe(BASE.clientId);
  });

  it('overrides all three credential fields when all BTG_PP_* are set', () => {
    process.env.BTG_PP_TENANT_ID     = 'pp-tenant';
    process.env.BTG_PP_CLIENT_ID     = 'pp-client';
    process.env.BTG_PP_CLIENT_SECRET = 'pp-secret';
    const creds = getPPCredentials(BASE);
    expect(creds.tenantId).toBe('pp-tenant');
    expect(creds.clientId).toBe('pp-client');
    expect(creds.clientSecret).toBe('pp-secret');
  });

  it('always preserves subscriptionId from base', () => {
    process.env.BTG_PP_CLIENT_ID = 'pp-client';
    const creds = getPPCredentials(BASE);
    expect(creds.subscriptionId).toBe(BASE.subscriptionId);
  });
});

describe('PP_SERVICE_LABELS', () => {
  it('contains all five PP analyzer labels', () => {
    expect(PP_SERVICE_LABELS.has('Power Platform')).toBe(true);
    expect(PP_SERVICE_LABELS.has('PP Environments')).toBe(true);
    expect(PP_SERVICE_LABELS.has('PP Apps')).toBe(true);
    expect(PP_SERVICE_LABELS.has('PP Flows')).toBe(true);
    expect(PP_SERVICE_LABELS.has('Power BI')).toBe(true);
  });

  it('does not contain Azure service labels', () => {
    expect(PP_SERVICE_LABELS.has('Storage')).toBe(false);
    expect(PP_SERVICE_LABELS.has('Key Vault')).toBe(false);
  });
});
