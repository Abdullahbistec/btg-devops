/**
 * Unit tests for btg-runner.ts PP credential helpers.
 *
 * Run with: npx vitest run lib/btg-runner.test.ts
 * (add vitest to devDependencies first: npm i -D vitest)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPPCredentials, PP_SERVICE_LABELS, extractLocation, extractMonthlyCost, extractMonthlySaving, extractConfidence, parseHetznerCostReport } from './btg-runner';

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

describe('extractLocation', () => {
  it('prefers the generic location field', () => {
    expect(extractLocation({ location: 'eastus', datacenter: 'fsn1-dc14' } as any)).toBe('eastus');
  });
  it('falls back to datacenter (Hetzner servers)', () => {
    expect(extractLocation({ datacenter: 'fsn1-dc14' } as any)).toBe('fsn1-dc14');
  });
  it('falls back to home_location (Hetzner floating IPs)', () => {
    expect(extractLocation({ home_location: 'nbg1' } as any)).toBe('nbg1');
  });
  it('returns empty string when nothing is present', () => {
    expect(extractLocation({} as any)).toBe('');
  });
});

describe('extractMonthlyCost', () => {
  it('prefers the generic monthly_cost field', () => {
    expect(extractMonthlyCost({ monthly_cost: 12.5, est_monthly_waste_eur: 4 } as any)).toBe(12.5);
  });
  it('falls back to est_monthly_waste_eur (Hetzner volumes)', () => {
    expect(extractMonthlyCost({ est_monthly_waste_eur: 4 } as any)).toBe(4);
  });
  it('returns null when nothing is present', () => {
    expect(extractMonthlyCost({} as any)).toBeNull();
  });
});

describe('extractMonthlySaving', () => {
  it('returns the monthly_saving field when present', () => {
    expect(extractMonthlySaving({ monthly_saving: 8 } as any)).toBe(8);
  });
  it('returns null when absent', () => {
    expect(extractMonthlySaving({} as any)).toBeNull();
  });
});

describe('extractConfidence', () => {
  it('returns the confidence field when present (Claude-based analysis engine findings)', () => {
    expect(extractConfidence({ confidence: 0.72 } as any)).toBe(0.72);
  });
  it('returns null when absent (the rule-based fallback path never sets it)', () => {
    expect(extractConfidence({} as any)).toBeNull();
  });
});

describe('parseHetznerCostReport', () => {
  const validJson = JSON.stringify({
    currency: 'USD',
    total_monthly: 246.894,
    by_category: { servers: 213.35, volumes: 24.544 },
    by_type: { cpx32: { count: 1, monthly_total: 41.99 } },
    estimate: true,
    note: 'List-price estimate from the Hetzner pricing API. Not a bill.',
  });

  it('parses a well-formed report', () => {
    const result = parseHetznerCostReport(validJson);
    expect(result.currency).toBe('USD');
    expect(result.totalMonthly).toBeCloseTo(246.894, 3);
    expect(result.byCategory.servers).toBeCloseTo(213.35, 2);
    expect(result.estimate).toBe(true);
  });

  it('defaults by_category/by_type to {} when legitimately absent', () => {
    const result = parseHetznerCostReport(JSON.stringify({ currency: 'USD', total_monthly: 0 }));
    expect(result.byCategory).toEqual({});
    expect(result.byType).toEqual({});
  });

  it('throws rather than silently defaulting to EUR when currency is missing', () => {
    const missingCurrency = JSON.stringify({ total_monthly: 246.894, by_category: {}, by_type: {} });
    expect(() => parseHetznerCostReport(missingCurrency)).toThrow(/currency/i);
  });

  it('throws rather than silently defaulting to 0 when total_monthly is missing', () => {
    const missingTotal = JSON.stringify({ currency: 'USD', by_category: {}, by_type: {} });
    expect(() => parseHetznerCostReport(missingTotal)).toThrow(/total_monthly/i);
  });
});
