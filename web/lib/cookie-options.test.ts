import { describe, it, expect, afterEach } from 'vitest';
import { sessionCookieOptions } from './auth';

function withNodeEnv(value: string, fn: () => void) {
  // Node's process.env has special defineProperty handling that requires the
  // full descriptor (writable/enumerable/configurable), not just the fields
  // being changed — omitting them throws "only accepts a configurable,
  // writable, and enumerable data descriptor".
  const saved = process.env.NODE_ENV;
  Object.defineProperty(process.env, 'NODE_ENV', { value, writable: true, enumerable: true, configurable: true });
  try { fn(); } finally {
    Object.defineProperty(process.env, 'NODE_ENV', { value: saved, writable: true, enumerable: true, configurable: true });
  }
}

describe('sessionCookieOptions', () => {
  it('sets Secure in production', () => {
    withNodeEnv('production', () => {
      expect(sessionCookieOptions(3600).secure).toBe(true);
    });
  });

  it('does not set Secure in development, where the app runs on plain http', () => {
    // A Secure cookie is dropped by the browser on http://localhost, which
    // would make local login fail with no visible error.
    withNodeEnv('development', () => {
      expect(sessionCookieOptions(3600).secure).toBe(false);
    });
  });

  it('keeps httpOnly, SameSite=Lax, path=/ and the requested maxAge', () => {
    const opts = sessionCookieOptions(28800);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(28800);
  });
});
