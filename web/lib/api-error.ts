import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

/** Generic 500 for an unexpected failure.
 *
 * The routes used to return `(e as Error).message` straight to the caller,
 * which for a pg error is the table name, the column name and the constraint
 * that failed — free schema reconnaissance for anyone probing the API. The
 * detail still exists, it just goes to the server log under a correlation id
 * the caller can quote in a bug report.
 *
 * Only for *unexpected* failures. Deliberate 400/401/403/404/409 responses
 * are the API's contract and must keep their own specific messages. */
export function apiError(e: unknown, context: string): NextResponse {
  const correlationId = randomUUID();
  console.error(`[api-error ${correlationId}] ${context}:`, e);
  return NextResponse.json(
    {
      error: 'Something went wrong on our side. Quote this reference if you report it.',
      correlationId,
    },
    { status: 500 }
  );
}
