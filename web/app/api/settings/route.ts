import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { isAdminRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const btgPath = process.env.BTG_DEVOPS_PATH
    ? path.resolve(process.cwd(), process.env.BTG_DEVOPS_PATH)
    : path.resolve(process.cwd(), '..', 'btg-devops.exe');

  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'btg-devops.db');

  return NextResponse.json({
    tenantId:          process.env.AZURE_TENANT_ID     || '',
    clientId:          process.env.AZURE_CLIENT_ID     || '',
    clientSecretSet:   !!(process.env.AZURE_CLIENT_SECRET),
    subscriptionId:    process.env.AZURE_SUBSCRIPTION_ID || '',
    ppTenantId:        process.env.BTG_PP_TENANT_ID    || '',
    ppClientId:        process.env.BTG_PP_CLIENT_ID    || '',
    ppClientSecretSet: !!(process.env.BTG_PP_CLIENT_SECRET),
    btgPath,
    dbPath,
  });
}
