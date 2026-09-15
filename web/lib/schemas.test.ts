import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { parseBody, findingPatchSchema, schedulePostSchema } from './schemas';

function jsonRequest(body: unknown) {
  return new NextRequest('http://localhost/api/whatever', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('parseBody', () => {
  it('accepts a valid body and hands back typed data', async () => {
    const result = await parseBody(jsonRequest({ remediation_status: 'resolved' }), findingPatchSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.remediation_status).toBe('resolved');
  });

  it('rejects an unknown remediation_status with 400', async () => {
    const result = await parseBody(jsonRequest({ remediation_status: 'deleted' }), findingPatchSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it('rejects fields the schema does not declare', async () => {
    // Mass assignment: nothing should be able to smuggle extra columns past
    // a handler that only reads the two it knows about.
    const result = await parseBody(
      jsonRequest({ remediation_status: 'open', audit_id: 'somebody-elses-audit' }),
      findingPatchSchema
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a body that is not an object at all', async () => {
    const req = new NextRequest('http://localhost/api/whatever', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '"just a string"',
    });
    const result = await parseBody(req, findingPatchSchema);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON with 400 rather than throwing', async () => {
    const req = new NextRequest('http://localhost/api/whatever', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{ not json',
    });
    const result = await parseBody(req, findingPatchSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it('does not leak the schema internals in the error body', async () => {
    const result = await parseBody(jsonRequest({ remediation_status: 'nope' }), findingPatchSchema);
    if (!result.ok) {
      const body = await result.response.json();
      expect(JSON.stringify(body)).not.toContain('ZodError');
    }
  });
});

describe('findingPatchSchema', () => {
  it('requires at least one of the two updatable fields', async () => {
    const result = await parseBody(jsonRequest({}), findingPatchSchema);
    expect(result.ok).toBe(false);
  });

  it('caps support_ticket_ref at 200 characters', async () => {
    const result = await parseBody(jsonRequest({ support_ticket_ref: 'x'.repeat(201) }), findingPatchSchema);
    expect(result.ok).toBe(false);
  });
});

describe('schedulePostSchema', () => {
  it('only accepts times_per_day values that divide 24 evenly', async () => {
    // computeNextRun assumes slots land on the hour; 5 would drift.
    const ok = await parseBody(jsonRequest({ frequency: 'daily', hour: 2, times_per_day: 4 }), schedulePostSchema);
    expect(ok.ok).toBe(true);

    const bad = await parseBody(jsonRequest({ frequency: 'daily', hour: 2, times_per_day: 5 }), schedulePostSchema);
    expect(bad.ok).toBe(false);
  });

  it('rejects an hour outside 0-23', async () => {
    const result = await parseBody(jsonRequest({ frequency: 'daily', hour: 24 }), schedulePostSchema);
    expect(result.ok).toBe(false);
  });
});
