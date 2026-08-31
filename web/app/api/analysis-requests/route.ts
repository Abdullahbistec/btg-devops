import { NextRequest, NextResponse } from 'next/server';
import { createAnalysisRequest } from '@/lib/db';

/** Creates a pending AI-analysis request. A scheduled Claude Code routine,
 * polling through the MCP server (cmd/mcp.go --http), picks it up, reasons
 * over the audit's findings, and writes the result back — no synchronous
 * LLM call happens in this request. See docs/ai-analysis-routine-setup.md. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auditId: string = body?.auditId || '';
    const scope: string = body?.scope || 'all';
    if (!auditId) {
      return NextResponse.json({ error: 'auditId is required' }, { status: 400 });
    }
    const request = await createAnalysisRequest(auditId, scope);
    return NextResponse.json({ id: request.id, status: request.status }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
