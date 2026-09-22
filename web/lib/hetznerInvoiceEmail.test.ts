import { describe, it, expect } from 'vitest';

import { parseInvoicePdfText } from './hetznerInvoiceEmail';

describe('parseInvoicePdfText', () => {
  it('parses an ISO-dated invoice with a Euro total', () => {
    const text = 'Invoice No: R2026091234567\nDate: 2026-09-01\nTotal Amount: €142.50\n';
    expect(parseInvoicePdfText(text)).toEqual({
      invoiceNumber: 'R2026091234567',
      date: '2026-09-01',
      currency: 'EUR',
      total: 142.5,
    });
  });

  it('parses a DD.MM.YYYY-dated invoice with a Dollar total, converting the date to ISO', () => {
    const text = 'Invoice Number: RX99887766\n01.09.2026\nTotal: $99.99\n';
    expect(parseInvoicePdfText(text)).toEqual({
      invoiceNumber: 'RX99887766',
      date: '2026-09-01',
      currency: 'USD',
      total: 99.99,
    });
  });

  it('throws with a diagnostic message when the invoice number is missing', () => {
    const text = 'Date: 2026-09-01\nTotal: €10.00\n';
    expect(() => parseInvoicePdfText(text)).toThrow(/number=false/);
  });

  it('throws with a diagnostic message when the total is missing', () => {
    const text = 'Invoice No: R2026091234567\nDate: 2026-09-01\n';
    expect(() => parseInvoicePdfText(text)).toThrow(/total=false/);
  });

  it('throws with a diagnostic message when the date is missing', () => {
    const text = 'Invoice No: R2026091234567\nTotal: €10.00\n';
    expect(() => parseInvoicePdfText(text)).toThrow(/date=false/);
  });
});
