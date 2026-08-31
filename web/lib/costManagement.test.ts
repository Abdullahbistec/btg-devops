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
