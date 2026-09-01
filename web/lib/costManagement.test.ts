import { describe, it, expect } from 'vitest';

import { parseMonthlyCostRows } from './costManagement';

describe('parseMonthlyCostRows', () => {
  it('reads the date bucket from BillingMonth (what Monthly granularity actually returns)', () => {
    // Exact column shape from the real backfill failure: Azure's Monthly
    // granularity response names the date column 'BillingMonth', not
    // 'UsageDate'.
    const columns = [
      { name: 'Cost' },
      { name: 'BillingMonth' },
      { name: 'ServiceName' },
      { name: 'Currency' },
    ];
    const rows: (string | number)[][] = [
      [120.5, 20260701, 'Virtual Machines', 'USD'],
      [30.25, 20260701, 'Storage', 'USD'],
      [200, 20260601, 'Virtual Machines', 'USD'],
    ];

    const result = parseMonthlyCostRows(columns, rows);

    expect(result.size).toBe(2);
    expect(result.get('2026-07')).toEqual({
      totalCost: 150.75,
      currency: 'USD',
      byService: [
        { name: 'Virtual Machines', cost: 120.5 },
        { name: 'Storage', cost: 30.25 },
      ],
    });
    expect(result.get('2026-06')).toEqual({
      totalCost: 200,
      currency: 'USD',
      byService: [{ name: 'Virtual Machines', cost: 200 }],
    });
  });

  it('still reads the date bucket from UsageDate if that column is present instead', () => {
    const columns = [{ name: 'Cost' }, { name: 'UsageDate' }, { name: 'ServiceName' }, { name: 'Currency' }];
    const rows: (string | number)[][] = [[50, 20260701, 'Key Vault', 'USD']];

    const result = parseMonthlyCostRows(columns, rows);

    expect(result.get('2026-07')).toEqual({
      totalCost: 50,
      currency: 'USD',
      byService: [{ name: 'Key Vault', cost: 50 }],
    });
  });

  it('throws a clear error when neither date column is present', () => {
    const columns = [{ name: 'Cost' }, { name: 'ServiceName' }, { name: 'Currency' }];

    expect(() => parseMonthlyCostRows(columns, [])).toThrow(
      /Cost Management response is missing the expected date column \(got: Cost, ServiceName, Currency\)/
    );
  });
});

describe('parseMonthlyCostRows — month bucketing is timezone-independent', () => {
  const columns = [{ name: 'Cost' }, { name: 'BillingMonth' }, { name: 'ServiceName' }, { name: 'Currency' }];

  it('buckets an ISO instant by its UTC month, not the host timezone month', () => {
    // Late-in-the-month UTC instant. Read through a host timezone ahead of
    // UTC (this machine is +05:30) the local date rolls into August, so the
    // old local-getter code filed July spend under 2026-08 — writing 0 for
    // one month and clobbering the neighbouring row.
    const result = parseMonthlyCostRows(columns, [[99.5, '2026-07-31T20:00:00Z', 'Virtual Machines', 'USD']]);

    expect([...result.keys()]).toEqual(['2026-07']);
    expect(result.get('2026-07')?.totalCost).toBe(99.5);
  });

  it('buckets an early-in-the-month ISO instant by its UTC month', () => {
    // The mirror case, which is what breaks on a host behind UTC.
    const result = parseMonthlyCostRows(columns, [[10, '2026-07-01T00:00:00Z', 'Storage', 'USD']]);
    expect([...result.keys()]).toEqual(['2026-07']);
  });

  it('still reads the plain YYYYMMDD integer form without going near Date', () => {
    const result = parseMonthlyCostRows(columns, [[5, 20260701, 'Storage', 'USD']]);
    expect([...result.keys()]).toEqual(['2026-07']);
  });
});
