import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

export const GENERIC_ERROR_TEXT = 'Something went wrong on our side. Quote this reference if you report it.';

/** Logs the real exception server-side under a correlation id and returns
 * that id. Shared by apiError() and by the couple of call sites that record
 * a failure message somewhere other than a direct response body (e.g. an
 * async job row a different route later reads) — those still need to avoid
 * leaking raw exception text, just not through a NextResponse. */
export function logServerError(e: unknown, context: string): string {
  const correlationId = randomUUID();
  console.error(`[api-error ${correlationId}] ${context}:`, e);
  return correlationId;
}

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
  const correlationId = logServerError(e, context);
  return NextResponse.json(
    { error: GENERIC_ERROR_TEXT, correlationId },
    { status: 500 }
  );
}
