import { NextResponse } from 'next/server';
import { executeAudit, AuditExecutorError } from '@/lib/audit-executor';
import { Command } from '@/lib/btg-runner';
import { isAdminRequest, getVerifiedIdentity } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { consumeRateLimit, rateLimited } from '@/lib/rate-limit';
import { recordAuditLog } from '@/lib/audit-log';
import type { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    if (!(await isAdminRequest(req))) {
      return NextResponse.json({ error: 'Viewers cannot trigger scans. Contact an admin.' }, { status: 403 });
    }
    const limit = await consumeRateLimit(`audits-run:account:${getVerifiedIdentity(req)}`, 10, 3600);
    if (!limit.allowed) return rateLimited(limit);

    const body = await req.json();
    const { subscription_id, commands, name } = body as {
      subscription_id: string;
      commands?: Command[];
      name?: string;
    };

    const { auditId } = await executeAudit(subscription_id, commands, name);
    await recordAuditLog(req, 'audits.run', { subscription_id, audit_id: auditId, commands });
    return NextResponse.json({ audit_id: auditId, status: 'running' }, { status: 202 });
  } catch (e) {
    if (e instanceof AuditExecutorError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    return apiError(e, 'POST /api/audits/run');
  }
}
