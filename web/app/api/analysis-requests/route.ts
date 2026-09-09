import { NextRequest, NextResponse } from 'next/server';
import { createAnalysisRequest } from '@/lib/db';
import { triggerQueueDrain } from '@/lib/routine-trigger';

/** Creates a pending AI-analysis request. A Claude Code agent polling through
 * the MCP server (cmd/mcp.go --http) picks it up, reasons over the audit's
 * findings, and writes the result back — no synchronous LLM call happens in
 * this request. See docs/ai-analysis-routine-setup.md. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auditId: string = body?.auditId || '';
    const scope: string = body?.scope || 'all';
    if (!auditId) {
      return NextResponse.json({ error: 'auditId is required' }, { status: 400 });
    }
    const request = await createAnalysisRequest(auditId, scope);
    // Kick a drain immediately rather than waiting for a poll tick, so a
    // Summarize click resolves in seconds instead of looking broken until
    // something else happens to run. Deliberately not awaited and never
    // throws (see triggerQueueDrain) — the row is queued either way, and a
    // no-op here just means it waits for the next trigger.
    triggerQueueDrain();
    return NextResponse.json({ id: request.id, status: request.status }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
