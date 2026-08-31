import { NextRequest, NextResponse } from 'next/server';
import { buildAuditContext } from '@/lib/analysisContext';
import { askGemini } from '@/lib/gemini';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auditId: string | undefined = body?.auditId || undefined;
    const mode: 'chat' | 'summary' = body?.mode === 'summary' ? 'summary' : 'chat';
    const question: string = body?.question || '';

    if (mode === 'chat' && !question.trim()) {
      return NextResponse.json({ error: 'question is required for mode "chat"' }, { status: 400 });
    }

    const context = await buildAuditContext(auditId);
    const prompt = mode === 'summary'
      ? `You are a cloud security analyst. Given these Azure and Power Platform audit findings, write a short executive risk summary (3-5 sentences) highlighting the most important issues and overall posture.\n\n${context}`
      : `You are a cloud security analyst. Given these Azure and Power Platform audit findings, answer the user's question concisely and specifically, referencing findings by name where relevant.\n\n${context}\n\nQuestion: ${question}`;

    const answer = await askGemini(prompt);
    return NextResponse.json({ answer });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
