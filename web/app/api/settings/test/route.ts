import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import path from 'path';

export async function POST() {
  const btgPath = process.env.BTG_DEVOPS_PATH
    ? path.resolve(process.cwd(), process.env.BTG_DEVOPS_PATH)
    : path.resolve(process.cwd(), '..', 'btg-devops.exe');

  if (!process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_ID || !process.env.AZURE_CLIENT_SECRET) {
    return NextResponse.json(
      { message: 'Missing credentials: AZURE_TENANT_ID, AZURE_CLIENT_ID, or AZURE_CLIENT_SECRET not set in .env.local' },
      { status: 400 }
    );
  }

  // Quick smoke test: run iam with a short timeout — if auth works it returns JSON
  return new Promise<NextResponse>(resolve => {
    execFile(
      btgPath,
      ['analyze', 'iam', '--output', 'json'],
      {
        env: { ...process.env },
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err && !stdout) {
          resolve(NextResponse.json(
            { message: `Connection failed: ${err.message.slice(0, 200)}` },
            { status: 502 }
          ));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const count = parsed?.findings?.length ?? parsed?.summary?.total_assignments ?? '?';
          resolve(NextResponse.json({ message: `Connected — IAM analyzer returned ${count} finding(s)` }));
        } catch {
          resolve(NextResponse.json({ message: 'Connected — received response from Azure' }));
        }
      }
    );
  });
}
