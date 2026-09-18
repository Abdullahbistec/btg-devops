import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiError } from './api-error';

afterEach(() => vi.restoreAllMocks());

describe('apiError', () => {
  it('does not leak the exception message to the caller', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pgish = new Error('relation "findings" does not exist at character 15');

    const body = await apiError(pgish, 'GET /api/findings').json();

    expect(JSON.stringify(body)).not.toContain('findings');
    expect(JSON.stringify(body)).not.toContain('character 15');
  });

  it('returns 500 and a correlation id the caller can quote', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await apiError(new Error('boom'), 'GET /api/findings');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.error).toBe('string');
  });

  it('logs the real detail server-side under the same correlation id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error('constraint "findings_audit_id_fkey" violated');

    const body = await apiError(original, 'PATCH /api/findings/[id]').json();

    const logged = spy.mock.calls[0].join(' ');
    expect(logged).toContain(body.correlationId);
    expect(logged).toContain('PATCH /api/findings/[id]');
    expect(spy.mock.calls[0]).toContain(original);
  });

  it('handles a thrown non-Error without crashing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await apiError('just a string', 'GET /api/dashboard');
    expect(res.status).toBe(500);
  });
});
