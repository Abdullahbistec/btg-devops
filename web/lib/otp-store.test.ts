import { describe, it, expect } from 'vitest';
import { generateOTP } from './otp-store';

describe('generateOTP', () => {
  it('always returns exactly 6 digits', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateOTP()).toMatch(/^\d{6}$/);
    }
  });

  it('can produce codes that start with 0', () => {
    // The regression: `100000 + Math.random() * 900000` could never emit a
    // leading zero, so the real keyspace was 900,000 rather than 1,000,000.
    // With a uniform draw over [0, 1e6) the chance of seeing no leading zero
    // in 500 draws is 0.9^500 — about 1 in 10^23.
    const codes = Array.from({ length: 500 }, () => generateOTP());
    expect(codes.some(c => c.startsWith('0'))).toBe(true);
  });
});
