import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';
import { encryptSecret, decryptSecret } from './crypto';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

describe('decryptSecret', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY_A;
  });

  it('round-trips a secret', () => {
    expect(decryptSecret(encryptSecret('s3cr3t-value'))).toBe('s3cr3t-value');
  });

  it('passes through a value that was never encrypted', () => {
    // The legacy case this fallback exists for: a plaintext secret seeded
    // from an env var before the scheme existed — including one that
    // happens to contain two colons.
    expect(decryptSecret('plain-text-secret')).toBe('plain-text-secret');
    expect(decryptSecret('a:b:c')).toBe('a:b:c');
    expect(decryptSecret('')).toBe('');
  });

  it('throws rather than returning ciphertext when the key no longer matches', () => {
    const encrypted = encryptSecret('real-azure-client-secret');
    process.env.ENCRYPTION_KEY = KEY_B; // simulates a rotated ENCRYPTION_KEY

    // The regression: this used to return `encrypted` — the raw ciphertext —
    // which callers handed to Azure as a live client secret, producing an
    // opaque auth failure that pointed nowhere near the key.
    expect(() => decryptSecret(encrypted)).toThrow(/ENCRYPTION_KEY/);
    expect(() => decryptSecret(encrypted)).not.toThrow(/^$/);
  });

  it('throws when the ciphertext has been tampered with', () => {
    const encrypted = encryptSecret('tamper-me');
    const [iv, tag, ct] = encrypted.split(':');
    const flipped = ct.slice(0, -1) + (ct.endsWith('a') ? 'b' : 'a');
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('does not mistake a colon-containing plaintext for the encrypted shape', () => {
    // Right number of parts and all hex, but the IV/tag lengths are wrong,
    // so it must be treated as plaintext, not fed to the cipher.
    const looksClose = 'abcdef:0123456789:deadbeef';
    expect(decryptSecret(looksClose)).toBe(looksClose);
  });
});
