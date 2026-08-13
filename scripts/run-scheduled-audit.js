#!/usr/bin/env node
'use strict';
// Triggers one combined audit (all Azure + Power Platform + Hetzner
// commands) through the real /api/audits/run pipeline, exactly like
// scripts/run-hetzner-audit.js does for Hetzner alone — used by
// .github/workflows/scheduled-audit.yml once a live dashboard URL exists.
//
// Deliberately a no-op (exit 0) if DASHBOARD_BASE_URL isn't set, rather than
// a failure — the dashboard isn't deployed anywhere yet, so this step stays
// harmless until that changes; nothing else needs to be edited on that day,
// just set the DASHBOARD_BASE_URL repo variable and the ADMIN_EMAIL/
// ADMIN_PASSWORD secrets.

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// Mirrors web/lib/btg-commands.ts's ALL_COMMANDS — duplicated here rather
// than imported because this is a plain Node script, not run through
// Next.js/ts-node, and can't import a .ts file directly. Same duplication
// already exists between the Go and TS command lists (see
// docs/consolidation-plan.md §2.1) — not fixed here, just not made worse.
const ALL_COMMANDS = [
  'appservice-traffic', 'storage', 'nsg', 'acr', 'cosmosdb', 'keyvault',
  'functions', 'publicip', 'appserviceplan', 'cognitiveservices',
  'resourcegroup', 'iam', 'sp-expiry', 'idle',
  'powerplatform', 'pp-environments', 'pp-apps', 'pp-flows', 'pp-powerbi',
  'hetzner-servers', 'hetzner-volumes', 'hetzner-floatingips',
  'hetzner-firewalls', 'hetzner-certificates',
];

function loadDotEnvLocalIfPresent() {
  const envPath = path.join(ROOT, 'web', '.env.local');
  if (!fs.existsSync(envPath)) return; // fine in CI — real env vars are already set
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
loadDotEnvLocalIfPresent();

async function main() {
  const baseUrl = process.env.DASHBOARD_BASE_URL;
  if (!baseUrl) {
    console.log('DASHBOARD_BASE_URL not set — dashboard not deployed yet. Skipping (not a failure).');
    return;
  }
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    console.error('DASHBOARD_BASE_URL is set but ADMIN_EMAIL/ADMIN_PASSWORD are missing.');
    process.exit(1);
  }

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
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

  const runRes = await fetch(`${baseUrl}/api/audits/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ commands: ALL_COMMANDS, name: 'Scheduled Governance Audit' }),
  });
  const runBody = await runRes.json();
  if (!runRes.ok) {
    console.error('Audit trigger failed:', runRes.status, runBody);
    process.exit(1);
  }
  console.log('Audit triggered:', runBody);

  const auditId = runBody.audit_id;
  for (let i = 0; i < 200; i++) { // up to ~10 minutes — idle covers idle's own longer timeout headroom
    await new Promise(r => setTimeout(r, 3000));
    const listRes = await fetch(`${baseUrl}/api/audits`, { headers: { Cookie: cookieHeader } });
    if (!listRes.ok) continue;
    const audits = await listRes.json();
    const mine = audits.find(a => a.id === auditId);
    if (mine && (mine.status === 'completed' || mine.status === 'failed')) {
      console.log('\nFinal status:', JSON.stringify(mine, null, 2));
      if (mine.status === 'failed') process.exit(1);
      return;
    }
    process.stdout.write('.');
  }
  console.error('\nTimed out waiting for the audit to complete.');
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
