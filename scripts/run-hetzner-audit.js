#!/usr/bin/env node
'use strict';
// Triggers a real, recorded Hetzner audit through the actual web app pipeline
// (not a standalone script) so it shows up correctly on the dashboard —
// logs in as admin using credentials read from web/.env.local (never
// printed), then POSTs to /api/audits/run with the 5 Hetzner commands.

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

function loadDotEnvLocal() {
  const envPath = path.join(ROOT, 'web', '.env.local');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

async function main() {
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error('Login failed:', loginRes.status);
    process.exit(1);
  }
  const setCookie = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
  const cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');

  const runRes = await fetch(`${BASE_URL}/api/audits/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({
      commands: ['hetzner-servers', 'hetzner-volumes', 'hetzner-floatingips', 'hetzner-firewalls', 'hetzner-certificates'],
      name: 'Hetzner Governance Scan',
    }),
  });
  const runBody = await runRes.json();
  if (!runRes.ok) {
    console.error('Audit trigger failed:', runRes.status, runBody);
    process.exit(1);
  }
  console.log('Audit triggered:', runBody);
  console.log('Polling for completion...');

  const auditId = runBody.audit_id;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const listRes = await fetch(`${BASE_URL}/api/audits`, { headers: { Cookie: cookieHeader } });
    if (!listRes.ok) continue;
    const audits = await listRes.json();
    const mine = audits.find(a => a.id === auditId);
    if (mine && (mine.status === 'completed' || mine.status === 'failed')) {
      console.log('\nFinal status:', JSON.stringify(mine, null, 2));
      return;
    }
    process.stdout.write('.');
  }
  console.log('\nTimed out waiting for completion — check the dashboard directly.');
}

main().catch(e => { console.error(e); process.exit(1); });
