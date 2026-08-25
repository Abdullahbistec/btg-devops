#!/usr/bin/env node
'use strict';
// Requests a cost refresh for every active subscription through the real
// /api/cost-requests endpoint — the exact same one the dashboard's
// "Refresh" button calls, so there is no second code path to keep correct.
// Mirrors scripts/run-scheduled-audit.js's login/no-op pattern; see
// docs/superpowers/specs/2026-08-25-cost-snapshot-history-design.md.
//
// Deliberately a no-op (exit 0) if DASHBOARD_BASE_URL isn't set, rather
// than a failure — the dashboard isn't deployed anywhere yet, so this step
// stays harmless until that changes.

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

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

  const subsRes = await fetch(`${baseUrl}/api/subscriptions`, { headers: { Cookie: cookieHeader } });
  if (!subsRes.ok) {
    console.error('Listing subscriptions failed:', subsRes.status);
    process.exit(1);
  }
  const subs = await subsRes.json();
  const active = Array.isArray(subs) ? subs.filter(s => s.is_active) : [];
  if (active.length === 0) {
    console.log('No active subscriptions — nothing to refresh.');
    return;
  }

  let anyFailed = false;
  for (const sub of active) {
    const res = await fetch(`${baseUrl}/api/cost-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ subscriptionId: sub.id }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error(`Cost refresh request failed for ${sub.name} (${sub.id}):`, res.status, body);
      anyFailed = true;
      continue;
    }
    console.log(`Cost refresh requested for ${sub.name} (${sub.id}):`, body);
  }
  if (anyFailed) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
