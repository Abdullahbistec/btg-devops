import { NextResponse } from 'next/server';
import { executeAudit, AuditExecutorError } from '@/lib/audit-executor';
import { Command } from '@/lib/btg-runner';
import { isAdminRequest } from '@/lib/auth';
import type { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    if (!(await isAdminRequest(req))) {
      return NextResponse.json({ error: 'Viewers cannot trigger scans. Contact an admin.' }, { status: 403 });
    }
    const body = await req.json();
    const { subscription_id, commands, name } = body as {
      subscription_id: string;
      commands?: Command[];
      name?: string;
    };

    const { auditId } = await executeAudit(subscription_id, commands, name);
    return NextResponse.json({ audit_id: auditId, status: 'running' }, { status: 202 });
  } catch (e) {
    if (e instanceof AuditExecutorError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
