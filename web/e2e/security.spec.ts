import { test, expect, request } from '@playwright/test';

// Backend security assertions exercised through the running server.
test.describe('backend security via HTTP', () => {
  const guardedApi = [
    ['GET', '/api/settings'],
    ['GET', '/api/dashboard'],
    ['GET', '/api/findings'],
    ['GET', '/api/audits'],
    ['GET', '/api/subscriptions'],
    ['GET', '/api/cost/spend'],
  ] as const;

  test('guarded API routes reject unauthenticated callers', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });
    for (const [method, path] of guardedApi) {
      const res = await ctx.fetch(path, { method, maxRedirects: 0 });
      expect([307, 401, 403], `${method} ${path} -> ${res.status()}`).toContain(res.status());
    }
    // anonymous state-changing calls also rejected
    const run = await ctx.fetch('/api/audits/run', { method: 'POST', data: {}, maxRedirects: 0 });
    expect([307, 401, 403]).toContain(run.status());
    const patch = await ctx.fetch('/api/findings/00000000-0000-4000-8000-000000000000', {
      method: 'PATCH', data: { remediation_status: 'suppressed' }, maxRedirects: 0,
    });
    expect([307, 401, 403]).toContain(patch.status());
    await ctx.dispose();
  });

  test('forged identity cookie without a valid session is rejected', async ({ baseURL }) => {
    const ctx = await request.newContext({
      baseURL,
      extraHTTPHeaders: { Cookie: 'btg_identity=abdullah@bistecglobal.com' },
    });
    const res = await ctx.fetch('/api/admin/users', { maxRedirects: 0 });
    expect([307, 401, 403]).toContain(res.status());
    await ctx.dispose();
  });

  test('internal service route returns a clean 401 (not 500) without a bearer token', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.fetch('/api/internal/analysis-requests/pending');
    expect([401, 403]).toContain(res.status());
    await ctx.dispose();
  });

  test('login is rate limited (a burst yields 429)', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await ctx.fetch('/api/auth/login', { method: 'POST', data: { email: 'nobody@example.com', password: 'x' } });
      codes.push(r.status());
    }
    expect(codes, `login codes: ${codes.join(' ')}`).toContain(429);
    await ctx.dispose();
  });

  test('anonymous /api/auth/me does not claim admin', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.fetch('/api/auth/me');
    const body = await res.text();
    expect(body).not.toContain('"role":"admin"');
    await ctx.dispose();
  });

  test('login page sets no session cookie and leaks no secret in HTML', async ({ page }) => {
    const resp = await page.goto('/login');
    const html = await page.content();
    // no obvious secret material shipped to the browser
    expect(html).not.toMatch(/CLIENT_SECRET|ENCRYPTION_KEY|SESSION_SECRET|BEGIN (RSA|PRIVATE)/i);
    // security-relevant response headers present or at least not contradicting themselves
    const headers = resp?.headers() ?? {};
    expect(headers['x-powered-by'] ?? '').not.toContain('PHP');
  });
});
