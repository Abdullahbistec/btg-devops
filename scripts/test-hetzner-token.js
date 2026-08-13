#!/usr/bin/env node
'use strict';
// One-off connectivity check for a newly-added HCLOUD_TOKEN. Reads the token
// from web/.env.local directly (never as a CLI arg, never printed) and runs
// every registered Hetzner analyzer (via `analyze hetzner`) to confirm the
// credential works end to end, not just against one endpoint.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BINARY = path.join(ROOT, process.platform === 'win32' ? 'btg-devops.exe' : 'btg-devops');

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

if (!process.env.HCLOUD_TOKEN) {
  console.error('HCLOUD_TOKEN not found in web/.env.local');
  process.exit(1);
}

try {
  const raw = execFileSync(BINARY, ['analyze', 'hetzner', '--output', 'json'], {
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120 * 1000,
  });
  const findings = JSON.parse(raw.toString('utf8'));
  const byService = {};
  const bySeverity = { Critical: 0, Warning: 0, Info: 0 };
  for (const f of findings) {
    byService[f.service] = (byService[f.service] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  console.log('HCLOUD_TOKEN is VALID — all 5 Hetzner analyzers ran successfully.');
  console.log(`Total findings: ${findings.length}`);
  console.log('By severity:', JSON.stringify(bySeverity));
  console.log('By analyzer:', JSON.stringify(byService, null, 2));
} catch (e) {
  const msg = String(e.message || e).split(process.env.HCLOUD_TOKEN).join('****REDACTED****');
  console.error('Check FAILED:');
  console.error(msg);
  process.exit(1);
}
