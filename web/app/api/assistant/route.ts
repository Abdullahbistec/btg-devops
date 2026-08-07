import { NextRequest, NextResponse } from 'next/server';
import { listFindings, getDashboardStats } from '@/lib/db';
import { askGemini } from '@/lib/gemini';

const TOP_FINDINGS_LIMIT = 20;

function buildContext(auditId?: string): string {
  const stats = getDashboardStats(auditId);
  const findings = listFindings(auditId);

  const severityCounts = stats.bySeverity.map(s => `${s.severity}: ${s.count}`).join(', ');
  const serviceCounts = stats.byService.map(s => `${s.service}: ${s.count}`).join(', ');

  const severityOrder: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
  const top = [...findings]
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))
    .slice(0, TOP_FINDINGS_LIMIT)
    .map(f => `- [${f.severity}] ${f.service}/${f.resource || '(n/a)'}: ${f.description}`)
    .join('\n');

  return [
    `Total findings: ${findings.length}`,
    `By severity: ${severityCounts || 'none'}`,
    `By service: ${serviceCounts || 'none'}`,
    findings.length ? `Top findings:\n${top}` : 'No findings recorded for this audit.',
  ].join('\n\n');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auditId: string | undefined = body?.auditId || undefined;
    const mode: 'chat' | 'summary' = body?.mode === 'summary' ? 'summary' : 'chat';
    const question: string = body?.question || '';

    if (mode === 'chat' && !question.trim()) {
      return NextResponse.json({ error: 'question is required for mode "chat"' }, { status: 400 });
    }

    const context = buildContext(auditId);
    const prompt = mode === 'summary'
      ? `You are a cloud security analyst. Given these Azure and Power Platform audit findings, write a short executive risk summary (3-5 sentences) highlighting the most important issues and overall posture.\n\n${context}`
      : `You are a cloud security analyst. Given these Azure and Power Platform audit findings, answer the user's question concisely and specifically, referencing findings by name where relevant.\n\n${context}\n\nQuestion: ${question}`;

    const answer = await askGemini(prompt);
    return NextResponse.json({ answer });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
