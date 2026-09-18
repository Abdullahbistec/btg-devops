// N1 follow-up from the live security test pass: confirm every
// /api/internal/* route rejects a tokenless caller with a clean 401, not a
// 500. These routes sit on lib/auth.isInternalServiceRequest — a different
// secret (MCP_INTERNAL_TOKEN) from user sessions, since the caller is the
// MCP server, not a browser — and web/middleware.ts deliberately treats
// /api/internal as a public prefix so its own bearer-token check is the
// only gate. Each handler must check that gate before touching params or
// the database, so an unauthenticated call never reaches code that could
// throw.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as pendingAnalysisGet } from '@/app/api/internal/analysis-requests/pending/route';
import { GET as pendingCostGet } from '@/app/api/internal/cost-requests/pending/route';
import { GET as analysisContextGet } from '@/app/api/internal/analysis-requests/[id]/context/route';
import { POST as analysisCompletePost } from '@/app/api/internal/analysis-requests/[id]/complete/route';
import { POST as costFetchPost } from '@/app/api/internal/cost-requests/[id]/fetch/route';

function tokenlessRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

function wrongTokenRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: 'Bearer not-the-right-token' },
  });
}

describe('/api/internal/* — rejects an unauthenticated caller with 401, not 500', () => {
  const ORIGINAL_TOKEN = process.env.MCP_INTERNAL_TOKEN;

  beforeEach(() => {
    process.env.MCP_INTERNAL_TOKEN = 'test-mcp-internal-token';
  });
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.MCP_INTERNAL_TOKEN;
    else process.env.MCP_INTERNAL_TOKEN = ORIGINAL_TOKEN;
  });

  const cases: [string, (req: NextRequest) => Promise<Response>][] = [
    ['GET /api/internal/analysis-requests/pending', (req) => pendingAnalysisGet(req)],
    ['GET /api/internal/cost-requests/pending', (req) => pendingCostGet(req)],
    ['GET /api/internal/analysis-requests/:id/context', (req) => analysisContextGet(req, { params: Promise.resolve({ id: 'r1' }) })],
    ['POST /api/internal/analysis-requests/:id/complete', (req) => analysisCompletePost(req, { params: Promise.resolve({ id: 'r1' }) })],
    ['POST /api/internal/cost-requests/:id/fetch', (req) => costFetchPost(req, { params: Promise.resolve({ id: 'r1' }) })],
  ];

  it.each(cases)('%s — no Authorization header → 401', async (_label, call) => {
    const res = await call(tokenlessRequest('/api/internal/x'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it.each(cases)('%s — wrong bearer token → 401', async (_label, call) => {
    const res = await call(wrongTokenRequest('/api/internal/x'));
    expect(res.status).toBe(401);
  });

  it.each(cases)('%s — MCP_INTERNAL_TOKEN unset → 401, never falls back to authorized', async (_label, call) => {
    delete process.env.MCP_INTERNAL_TOKEN;
    const res = await call(tokenlessRequest('/api/internal/x'));
    expect(res.status).toBe(401);
  });
});
