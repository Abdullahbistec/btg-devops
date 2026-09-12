import { describe, it, expect } from 'vitest';
import { formatFindingLine, buildCostBlock } from './analysisContext';

describe('analysis context cost signal', () => {
  it('appends cost to a finding line when present', () => {
    const line = formatFindingLine({
      severity: 'Critical', service: 'Hetzner Volumes', resource: 'orphan-1',
      description: 'unattached', monthly_cost: 7.67, currency: 'USD',
    });
    expect(line).toContain('7.67');
    expect(line).toContain('USD');
  });

  it('omits cost entirely when the finding has none', () => {
    const line = formatFindingLine({
      severity: 'Critical', service: 'ACR', resource: 'acr1',
      description: 'admin enabled', monthly_cost: null, currency: null,
    });
    expect(line).toBe('- [Critical] ACR/acr1: admin enabled');
  });

  it('labels the run rate as an estimate so the agent cannot quote it as a bill', () => {
    const block = buildCostBlock([{ currency: 'USD', total: 31.4 }], { totalMonthly: 246.89, currency: 'USD' });
    expect(block).toContain('246.89');
    expect(block.toLowerCase()).toContain('estimate');
  });

  it('does not corrupt a description that itself contains " /mo"', () => {
    const line = formatFindingLine({
      severity: 'Warning', service: 'Hetzner Volumes', resource: 'vol-1',
      description: 'billed at 5 /mo previously, now orphaned', monthly_cost: 7.67, currency: 'USD',
    });
    // The description must survive intact...
    expect(line).toContain('billed at 5 /mo previously, now orphaned');
    // ...and the trailing cost suffix must still be correctly appended.
    expect(line).toMatch(/— 7\.67 USD\/mo$/);
  });

  it('does not sum findings priced in different currencies into one total', () => {
    const block = buildCostBlock(
      [
        { currency: 'USD', total: 10 },
        { currency: 'EUR', total: 20 },
      ],
      null
    );
    // Each currency's subtotal must be reported...
    expect(block).toContain('10.00 USD');
    expect(block).toContain('20.00 EUR');
    // ...and never blended into a single combined figure such as "30.00".
    expect(block).not.toContain('30.00');
  });
});
