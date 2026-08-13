#!/usr/bin/env node
'use strict';

/**
 * BISTEC Power Platform Governance Agent — safe, read-only runner.
 *
 * Adapted from the agent spec reviewed in docs/consolidation-plan.md's
 * discussion thread, with two corrections:
 *
 *   1. It NEVER touches web/btg-devops.db (the live dashboard database).
 *      Everything is written under ./out/ and ./state/ instead — new files,
 *      not a copy-over-the-live-database operation. Loading a run's results
 *      into the live dashboard (if ever wanted) is a separate, explicit,
 *      reviewed step — not something this script does silently.
 *   2. It fixes the resource-field mapping bug this review surfaced
 *      (web/lib/btg-runner.ts's extractResource() was missing license_name
 *      entirely and checked a field name — sku_id — that the CLI never
 *      emits; see the fix applied there in the same session as this file).
 *
 * Usage:
 *   node scripts/pp-governance-agent.js
 *
 * Requires (one of):
 *   BTG_PP_TENANT_ID / BTG_PP_CLIENT_ID / BTG_PP_CLIENT_SECRET   (preferred — dedicated PP SP)
 *   AZURE_TENANT_ID  / AZURE_CLIENT_ID  / AZURE_CLIENT_SECRET    (fallback)
 * Read from the environment only — never accepted as CLI args, never logged.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'previous_run.json');
const BINARY = path.join(ROOT, process.platform === 'win32' ? 'btg-devops.exe' : 'btg-devops');

/** Loads web/.env.local into process.env for vars not already set — reading
 * the file directly is safer than exporting secrets into shell history or
 * passing them as CLI args. Never overwrites an already-set env var, and
 * never logs anything from the file. */
function loadDotEnvLocal() {
  const envPath = path.join(ROOT, 'web', '.env.local');
  if (!fs.existsSync(envPath)) return;
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

const COMMANDS = ['powerplatform', 'pp-environments', 'pp-apps', 'pp-flows', 'pp-powerbi'];

const SERVICE_LABELS = {
  powerplatform: 'Power Platform',
  'pp-environments': 'PP Environments',
  'pp-apps': 'PP Apps',
  'pp-flows': 'PP Flows',
  'pp-powerbi': 'Power BI',
};

// Rough, published per-seat monthly costs — same numbers cmd/powerplatform.go
// itself uses for its own waste estimate (ppMonthlyCostUSD), duplicated here
// only because this script doesn't have access to the CLI's internal Go
// state, not because the numbers are independently sourced.
const MONTHLY_COST_USD = {
  POWERAPPS_PER_USER: 20.0,
  POWERAPPS_PER_APP: 5.0,
  FLOW_PER_USER: 15.0,
  FLOW_PER_BUSINESS_PROCESS: 100.0,
  POWERBI_PRO: 10.0,
  POWERBI_PREMIUM_PER_USER: 20.0,
};

function resolveCredentials() {
  return {
    AZURE_TENANT_ID: process.env.BTG_PP_TENANT_ID || process.env.AZURE_TENANT_ID || '',
    AZURE_CLIENT_ID: process.env.BTG_PP_CLIENT_ID || process.env.AZURE_CLIENT_ID || '',
    AZURE_CLIENT_SECRET: process.env.BTG_PP_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET || '',
  };
}

function checkPrerequisites() {
  const missing = [];
  const creds = resolveCredentials();
  if (!creds.AZURE_TENANT_ID) missing.push('tenant ID: set BTG_PP_TENANT_ID or AZURE_TENANT_ID');
  if (!creds.AZURE_CLIENT_ID) missing.push('client ID: set BTG_PP_CLIENT_ID or AZURE_CLIENT_ID');
  if (!creds.AZURE_CLIENT_SECRET) missing.push('client secret: set BTG_PP_CLIENT_SECRET or AZURE_CLIENT_SECRET');
  if (!fs.existsSync(BINARY)) missing.push(`compiled CLI binary not found at ${BINARY} — run 'go build -o ${path.basename(BINARY)} .' first`);
  return missing;
}

/** Defense in depth: strip any credential value out of anything before it's
 * written to disk or printed. The analyzer commands are read-only and never
 * echo their own auth token in output, so this should never actually fire —
 * it's a backstop, not the primary control. */
function maskSecrets(str) {
  if (!str) return str;
  let masked = str;
  for (const v of Object.values(resolveCredentials())) {
    if (v && v.length >= 8) masked = masked.split(v).join('****REDACTED****');
  }
  return masked;
}

function runCommand(cmd) {
  const creds = resolveCredentials();
  const raw = execFileSync(BINARY, ['analyze', cmd, '--output', 'json'], {
    env: { ...process.env, ...creds },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw.toString('utf8'));
}

// Mirrors the FIXED extractResource() in web/lib/btg-runner.ts.
function extractResource(f) {
  return (
    f.app_name || f.flow_name || f.workspace || f.workspace_name ||
    f.license_name || f.sku_part_number || f.environment || ''
  );
}

function normalize(cmd, report) {
  const service = SERVICE_LABELS[cmd] || cmd;
  const findings = (report && report.findings) || [];
  return findings.map(f => ({
    service,
    resource: extractResource(f),
    environment: f.environment || '',
    severity: f.severity || 'Info',
    category: f.category || '',
    description: maskSecrets(f.description || ''),
    recommendation: maskSecrets(f.recommendation || ''),
    owner: f.owner || '',
    sku_part_number: f.sku_part_number || '',
    est_monthly_waste_usd: typeof f.est_monthly_waste_usd === 'number' ? f.est_monthly_waste_usd : null,
  }));
}

function findingKey(f) {
  // Includes environment — without it, two different apps/flows sharing a
  // name across different environments (common: "Overview", "App", etc.)
  // with the same category and a generic, non-per-resource description
  // (e.g. "App has no description") would collapse into a single finding.
  return crypto.createHash('sha1').update([f.service, f.environment, f.resource, f.category, f.description].join('~~')).digest('hex');
}

function loadPreviousRun() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { findings: [] };
  }
}

function classify(currentFindings, previousRun) {
  const nowISO = new Date().toISOString();
  const prevMap = new Map((previousRun.findings || []).map(f => [findingKey(f), f]));
  const currMap = new Map(currentFindings.map(f => [findingKey(f), f]));

  const fresh = [];
  const persisting = [];
  for (const [key, f] of currMap) {
    const prev = prevMap.get(key);
    if (!prev) {
      fresh.push({ ...f, first_seen: nowISO });
    } else {
      const firstSeen = prev.first_seen || nowISO;
      const ageDays = Math.floor((Date.now() - new Date(firstSeen).getTime()) / 86400000);
      persisting.push({ ...f, first_seen: firstSeen, age_days: ageDays });
    }
  }
  const resolved = [];
  for (const [key, f] of prevMap) {
    if (!currMap.has(key)) resolved.push(f);
  }
  return { new: fresh, persists: persisting, resolved };
}

function severityCounts(findings) {
  const counts = { Critical: 0, Warning: 0, Info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

function licenseWaste(findings) {
  const bySkU = {};
  for (const f of findings) {
    if (f.service !== 'Power Platform' || typeof f.est_monthly_waste_usd !== 'number') continue;
    bySkU[f.resource] = (bySkU[f.resource] || 0) + f.est_monthly_waste_usd;
  }
  const rows = Object.entries(bySkU).sort((a, b) => b[1] - a[1]);
  const totalMonthly = rows.reduce((sum, [, v]) => sum + v, 0);
  return { totalMonthly, totalAnnual: totalMonthly * 12, top3: rows.slice(0, 3) };
}

/** Writes a self-contained SQLite file matching docs/database-schema.sql's
 * audits + findings tables ONLY — a new file under ./out/, never the live
 * web/btg-devops.db. Safe to inspect, diff, or hand to someone else; not
 * wired to overwrite anything. */
function writeFindingsDB(dbPath, allFindings, coverageGaps) {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE audits (
      id TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      status TEXT DEFAULT 'completed',
      started_at TEXT,
      completed_at TEXT,
      total_findings INTEGER DEFAULT 0,
      critical_count INTEGER DEFAULT 0,
      warning_count INTEGER DEFAULT 0,
      info_count INTEGER DEFAULT 0,
      commands_run TEXT DEFAULT '[]',
      error_message TEXT DEFAULT ''
    );
    CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL REFERENCES audits(id),
      service TEXT NOT NULL,
      resource TEXT DEFAULT '',
      environment TEXT DEFAULT '',
      severity TEXT NOT NULL,
      category TEXT DEFAULT '',
      description TEXT DEFAULT '',
      recommendation TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const auditId = crypto.randomUUID();
  const counts = severityCounts(allFindings);
  const startedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO audits (id, name, started_at, completed_at, total_findings, critical_count, warning_count, info_count, commands_run, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    auditId, 'PP Governance Agent run', startedAt, startedAt,
    allFindings.length, counts.Critical, counts.Warning, counts.Info,
    JSON.stringify(COMMANDS), coverageGaps.length ? maskSecrets(coverageGaps.join('; ')) : ''
  );

  const insertFinding = db.prepare(`
    INSERT INTO findings (id, audit_id, service, resource, environment, severity, category, description, recommendation, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  for (const f of allFindings) {
    insertFinding.run(crypto.randomUUID(), auditId, f.service, f.resource, f.environment, f.severity, f.category, f.description, f.recommendation, f.owner);
  }
  db.exec('COMMIT');
  db.close();
  return auditId;
}

// Escapes markdown table-breaking characters — several real environment
// names in this tenant contain a literal "|" (e.g. "<Name> | BISTEC Global"
// personal dev environments), which otherwise misaligns every table row
// that includes them.
function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function buildReport({ allFindings, delta, coverageGaps, previousTotal }) {
  const counts = severityCounts(allFindings);
  const prevCounts = { Critical: 0, Warning: 0, Info: 0 };
  const waste = licenseWaste(allFindings);
  const lines = [];

  lines.push('# Power Platform Governance Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Executive summary
  lines.push('## Executive Summary');
  const worstCritical = allFindings.find(f => f.severity === 'Critical');
  const jump = previousTotal > 0 ? (allFindings.length - previousTotal) / previousTotal : 0;
  if (jump > 0.5) {
    lines.push(`> **Findings jumped ${Math.round(jump * 100)}% vs. the previous run** (${previousTotal} → ${allFindings.length}) — check for a removed DLP policy or a newly-created environment before assuming this is ${allFindings.length - previousTotal} new individual mistakes.`);
    lines.push('');
  }
  if (worstCritical) {
    lines.push(`The most urgent issue: **${worstCritical.category}** on \`${worstCritical.resource || '(unnamed)'}\` (${worstCritical.service}) — ${worstCritical.description}`);
  } else if (waste.totalMonthly > 0) {
    lines.push(`No Critical findings this run. Largest cost signal: **$${waste.totalMonthly.toFixed(0)}/month** (~$${waste.totalAnnual.toFixed(0)}/year) in estimated Power Platform license waste.`);
  } else {
    lines.push('No Critical findings and no significant license waste detected this run.');
  }
  lines.push(`${counts.Critical} Critical, ${counts.Warning} Warning, ${counts.Info} Info across ${allFindings.length} total findings.`);
  lines.push(`${delta.new.length} new since last run, ${delta.resolved.length} resolved, ${delta.persists.filter(f => f.age_days > 30).length} aging past 30 days.`);
  if (coverageGaps.length) {
    lines.push(`**Coverage gap:** ${coverageGaps.length} analyzer(s) failed to run — see below. This report is incomplete.`);
  }
  lines.push('');

  // Severity table
  lines.push('## Severity');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  lines.push(`| Critical | ${counts.Critical} |`);
  lines.push(`| Warning | ${counts.Warning} |`);
  lines.push(`| Info | ${counts.Info} |`);
  lines.push('');

  // License waste
  lines.push('## License Waste');
  lines.push(`Estimated: **$${waste.totalMonthly.toFixed(2)}/month** ($${waste.totalAnnual.toFixed(2)}/year)`);
  if (waste.top3.length) {
    lines.push('');
    lines.push('Top SKUs by waste:');
    for (const [sku, amount] of waste.top3) {
      lines.push(`- ${sku}: $${amount.toFixed(2)}/month`);
    }
  }
  lines.push('');

  // New findings
  lines.push(`## New Findings (${delta.new.length})`);
  if (delta.new.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Resource | Analyzer | Severity | Why it matters | Remediation |');
    lines.push('|---|---|---|---|---|');
    for (const f of delta.new) {
      lines.push(`| ${mdCell(f.resource || '(unnamed)')} | ${mdCell(f.service)} | ${mdCell(f.severity)} | ${mdCell(f.description)} | ${mdCell(f.recommendation)} |`);
    }
  }
  lines.push('');

  // Resolved
  lines.push(`## Resolved Since Last Run (${delta.resolved.length})`);
  if (delta.resolved.length === 0) {
    lines.push('None.');
  } else {
    for (const f of delta.resolved) {
      lines.push(`- ${f.resource || '(unnamed)'} — ${f.category} (${f.service})`);
    }
  }
  lines.push('');

  // Ageing
  const ageing = delta.persists.filter(f => f.age_days > 30).sort((a, b) => b.age_days - a.age_days);
  lines.push(`## Ageing Findings — Open >30 Days (${ageing.length})`);
  if (ageing.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Resource | Analyzer | Severity | Age (days) | Category |');
    lines.push('|---|---|---|---|---|');
    for (const f of ageing) {
      lines.push(`| ${mdCell(f.resource || '(unnamed)')} | ${mdCell(f.service)} | ${mdCell(f.severity)} | ${f.age_days} | ${mdCell(f.category)} |`);
    }
  }
  lines.push('');

  if (coverageGaps.length) {
    lines.push('## Coverage Gaps');
    for (const g of coverageGaps) lines.push(`- ${maskSecrets(g)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  console.log('BISTEC Power Platform Governance Agent — starting (read-only)');

  const missing = checkPrerequisites();
  if (missing.length) {
    console.error('STOPPING — missing prerequisite(s):');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const allFindings = [];
  const coverageGaps = [];

  for (const cmd of COMMANDS) {
    process.stderr.write(`  -> analyze ${cmd}\n`);
    try {
      const report = runCommand(cmd);
      const normalized = normalize(cmd, report);
      allFindings.push(...normalized);
      process.stderr.write(`     ${normalized.length} finding(s)\n`);
    } catch (e) {
      const msg = maskSecrets(String(e.message || e));
      coverageGaps.push(`${cmd}: ${msg}`);
      process.stderr.write(`     FAILED: ${msg}\n`);
    }
  }

  const previousRun = loadPreviousRun();
  const previousTotal = (previousRun.findings || []).length;
  const delta = classify(allFindings, previousRun);

  const dbPath = path.join(OUT_DIR, 'findings.db');
  const auditId = writeFindingsDB(dbPath, allFindings, coverageGaps);

  fs.writeFileSync(path.join(OUT_DIR, 'findings.json'), JSON.stringify(allFindings, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), buildReport({ allFindings, delta, coverageGaps, previousTotal }));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ generated_at: new Date().toISOString(), findings: [...delta.new, ...delta.persists] }, null, 2));

  console.log('');
  console.log(`Done. audit_id=${auditId}`);
  console.log(`  ${OUT_DIR}/findings.db`);
  console.log(`  ${OUT_DIR}/findings.json`);
  console.log(`  ${OUT_DIR}/report.md`);
  console.log(`  ${STATE_FILE}`);
  if (coverageGaps.length) {
    console.log(`WARNING: ${coverageGaps.length} analyzer(s) had coverage gaps — see report.md`);
  }
}

main();
