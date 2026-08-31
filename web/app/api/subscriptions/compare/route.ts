import { NextResponse } from 'next/server';
import { getDB, listSubscriptionsBasic } from '@/lib/db';

interface AuditSummary {
  id: string;
  name: string;
  completed_at: string;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
}

// Read-only, aggregate-only data (no credentials) — safe for viewer role, same
// as /api/dashboard.
export async function GET() {
  try {
    const db = await getDB();
    const subs = await listSubscriptionsBasic();

    const results = await Promise.all(subs.map(async sub => {
      const auditRes = await db.query(
        `SELECT id, name, completed_at, total_findings, critical_count, warning_count, info_count
         FROM audits WHERE subscription_id = $1 AND status = 'completed'
         ORDER BY completed_at DESC LIMIT 1`,
        [sub.id]
      );
      const audit = auditRes.rows[0] as AuditSummary | undefined;

      let byService: { service: string; count: number }[] = [];
      if (audit) {
        const byServiceRes = await db.query(
          `SELECT service, COUNT(*)::int as count FROM findings WHERE audit_id = $1 GROUP BY service ORDER BY count DESC LIMIT 8`,
          [audit.id]
        );
        byService = byServiceRes.rows as { service: string; count: number }[];
      }

      return {
        subscription: { id: sub.id, name: sub.name, is_active: sub.is_active },
        latestAudit: audit ?? null,
        byService,
      };
    }));

    return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
