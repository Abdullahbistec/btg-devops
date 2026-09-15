// Security regression suite for C3 (docs/security-static-review-2026-09.md):
// every one of these routes was reachable with zero authentication. One test
// per route/method asserts an anonymous caller (no cookies at all) is
// rejected before any handler logic runs — this is the "one authz test per
// route" item from the report's roadmap (§5, item 11).
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as findingsGet } from '@/app/api/findings/route';
import { GET as findingByIdGet, PATCH as findingByIdPatch } from '@/app/api/findings/[id]/route';
import { GET as dashboardGet } from '@/app/api/dashboard/route';
import { GET as costSpendGet } from '@/app/api/cost/spend/route';
import { GET as costHistoryGet } from '@/app/api/cost/history/route';
import { GET as hetznerGet } from '@/app/api/cost/hetzner/route';
import { GET as hetznerHistoryGet } from '@/app/api/cost/hetzner/history/route';
import { POST as hetznerBackfillPost } from '@/app/api/cost/hetzner/backfill/route';
import { GET as compareGet } from '@/app/api/subscriptions/compare/route';
import { POST as analysisRequestsPost } from '@/app/api/analysis-requests/route';
import { GET as analysisRequestByIdGet } from '@/app/api/analysis-requests/[id]/route';
import { GET as costRequestByIdGet } from '@/app/api/cost-requests/[id]/route';
import { GET as settingsGet } from '@/app/api/settings/route';
import { POST as settingsTestPost } from '@/app/api/settings/test/route';
import { GET as auditsGet } from '@/app/api/audits/route';
import { GET as scheduleGet } from '@/app/api/schedule/route';
import { GET as authUsersGet, PATCH as authUsersPatch, DELETE as authUsersDelete } from '@/app/api/auth/users/route';
import { GET as meGet } from '@/app/api/auth/me/route';

function anonRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

describe('C3 — routes reject an anonymous caller (no cookies at all)', () => {
  const cases: [string, () => Promise<Response>][] = [
    ['GET /api/findings', () => findingsGet(anonRequest('/api/findings'))],
    ['GET /api/findings/:id', () => findingByIdGet(anonRequest('/api/findings/f1'), { params: { id: 'f1' } })],
    ['PATCH /api/findings/:id', () => findingByIdPatch(
      anonRequest('/api/findings/f1', { method: 'PATCH', body: JSON.stringify({ remediation_status: 'suppressed' }) }),
      { params: { id: 'f1' } },
    )],
    ['GET /api/dashboard', () => dashboardGet(anonRequest('/api/dashboard'))],
    ['GET /api/cost/spend', () => costSpendGet(anonRequest('/api/cost/spend'))],
    ['GET /api/cost/history', () => costHistoryGet(anonRequest('/api/cost/history'))],
    ['GET /api/cost/hetzner', () => hetznerGet(anonRequest('/api/cost/hetzner'))],
    ['GET /api/cost/hetzner/history', () => hetznerHistoryGet(anonRequest('/api/cost/hetzner/history'))],
    ['POST /api/cost/hetzner/backfill', () => hetznerBackfillPost(anonRequest('/api/cost/hetzner/backfill', { method: 'POST', body: '{}' }))],
    ['GET /api/subscriptions/compare', () => compareGet(anonRequest('/api/subscriptions/compare'))],
    ['POST /api/analysis-requests', () => analysisRequestsPost(anonRequest('/api/analysis-requests', { method: 'POST', body: JSON.stringify({ auditId: 'a1' }) }))],
    ['GET /api/analysis-requests/:id', () => analysisRequestByIdGet(anonRequest('/api/analysis-requests/r1'), { params: { id: 'r1' } })],
    ['GET /api/cost-requests/:id', () => costRequestByIdGet(anonRequest('/api/cost-requests/r1'), { params: { id: 'r1' } })],
    ['GET /api/settings', () => settingsGet(anonRequest('/api/settings'))],
    ['POST /api/settings/test', () => settingsTestPost(anonRequest('/api/settings/test', { method: 'POST' }))],
    ['GET /api/audits', () => auditsGet(anonRequest('/api/audits'))],
    ['GET /api/schedule', () => scheduleGet(anonRequest('/api/schedule'))],
    ['GET /api/auth/users', () => authUsersGet(anonRequest('/api/auth/users'))],
    ['PATCH /api/auth/users', () => authUsersPatch(anonRequest('/api/auth/users', { method: 'PATCH', body: JSON.stringify({ id: 'u1', status: 'active' }) }))],
    ['DELETE /api/auth/users', () => authUsersDelete(anonRequest('/api/auth/users?id=u1', { method: 'DELETE' }))],
    ['GET /api/auth/me', () => meGet(anonRequest('/api/auth/me'))],
  ];

  it.each(cases)('%s → 401 or 403, not 200', async (_label, call) => {
    const res = await call();
    expect([401, 403]).toContain(res.status);
  });
});
