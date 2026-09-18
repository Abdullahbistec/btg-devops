import { execFile } from 'child_process';
import path from 'path';
import { AZURE_COMMANDS, PP_COMMANDS, HETZNER_COMMANDS, ALL_COMMANDS, PP_SERVICE_LABELS, HETZNER_SERVICE_LABELS } from './btg-commands';
import type { Command } from './btg-commands';

// Re-exported for existing server-side consumers (API routes, audit-executor.ts).
// Client components must import these from '@/lib/btg-commands' directly —
// this file is server-only (imports 'child_process') and cannot be bundled
// for the browser.
export { AZURE_COMMANDS, PP_COMMANDS, HETZNER_COMMANDS, ALL_COMMANDS, PP_SERVICE_LABELS, HETZNER_SERVICE_LABELS };
export type { Command };

export const isHetznerCommand = (cmd: string): boolean =>
  (HETZNER_COMMANDS as readonly string[]).includes(cmd);

const BTG_PATH = process.env.BTG_DEVOPS_PATH
  ? path.resolve(process.cwd(), process.env.BTG_DEVOPS_PATH)
  : path.resolve(process.cwd(), '..', 'btg-devops.exe');

export type Credentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
};

/**
 * Resolves Power Platform credentials.
 * BTG_PP_* env vars override the base Azure credential set, allowing a
 * separate service principal to be used for PP commands without touching
 * the AZURE_* vars used by the Azure analyzers.
 */
export function getPPCredentials(base: Credentials): Credentials {
  return {
    tenantId:       process.env.BTG_PP_TENANT_ID     || base.tenantId,
    clientId:       process.env.BTG_PP_CLIENT_ID     || base.clientId,
    clientSecret:   process.env.BTG_PP_CLIENT_SECRET || base.clientSecret,
    subscriptionId: base.subscriptionId,
  };
}

// Map command → service label for findings
const SERVICE_LABELS: Record<string, string> = {
  'appservice-traffic': 'App Service',
  'storage': 'Storage',
  'nsg': 'NSG',
  'acr': 'ACR',
  'cosmosdb': 'Cosmos DB',
  'keyvault': 'Key Vault',
  'functions': 'Functions',
  'publicip': 'Public IPs',
  'appserviceplan': 'App Service Plan',
  'cognitiveservices': 'Cognitive Services',
  'resourcegroup': 'Resource Groups',
  'iam': 'IAM',
  'sp-expiry': 'SP Expiry',
  'idle': 'Idle & Waste',
  'powerplatform': 'Power Platform',
  'pp-environments': 'PP Environments',
  'pp-apps': 'PP Apps',
  'pp-flows': 'PP Flows',
  'pp-powerbi': 'Power BI',
  'hetzner-servers': 'Hetzner Servers',
  'hetzner-volumes': 'Hetzner Volumes',
  'hetzner-floatingips': 'Hetzner Floating IPs',
  'hetzner-firewalls': 'Hetzner Firewalls',
  'hetzner-certificates': 'Hetzner Certificates',
};

export interface NormalizedFinding {
  service: string;
  resource: string;
  environment: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  owner: string;
  location: string;
  monthly_cost: number | null;
  monthly_saving: number | null;
  confidence: number | null;
  reasoning: string;
  currency: string | null;
}

interface RawFinding {
  severity?: string;
  category?: string;
  description?: string;
  recommendation?: string;
  owner?: string;
  location?: string;
  monthly_cost?: number;
  monthly_saving?: number;
  // Set only on findings produced by the Claude-based analysis engine
  // (cmd/storage_claude.go's handoffFindingsToStorageReport and friends) —
  // absent/zero-value on the Go rule-check fallback path.
  confidence?: number;
  reasoning?: string;
  // Azure fields
  account_name?: string;
  resource_name?: string;
  plan_name?: string;
  function_app_name?: string;
  ip_name?: string;
  vault_name?: string;
  nsg_name?: string;
  registry_name?: string;
  group_name?: string;
  resource_group?: string;
  // PP fields
  environment?: string;
  flow_name?: string;
  app_name?: string;
  workspace?: string;
  workspace_name?: string;
  license_name?: string;
  sku_part_number?: string;
  // SP Expiry fields
  credential_name?: string;
  app_id?: string;
  // Hetzner fields
  server_name?: string;
  volume_name?: string;
  name?: string;
  firewall_name?: string;
  cert_name?: string;
  datacenter?: string;
  home_location?: string;
  est_monthly_waste_eur?: number;
  currency?: string;
}

function extractResource(raw: RawFinding): string {
  return (
    raw.app_name || raw.account_name || raw.resource_name || raw.plan_name ||
    raw.function_app_name || raw.ip_name || raw.vault_name ||
    raw.nsg_name || raw.registry_name || raw.group_name ||
    raw.resource_group || raw.flow_name ||
    raw.workspace || raw.workspace_name ||
    raw.license_name || raw.sku_part_number || raw.credential_name ||
    raw.server_name || raw.volume_name || raw.firewall_name || raw.cert_name || raw.name ||
    // pp-environments findings have no other identifying field — without this,
    // every pp-environments finding's resource comes back blank (documented
    // in docs/consolidation-plan.md §2.2 / provider-extension-plan.md §1.9).
    raw.environment || ''
  );
}

export function extractLocation(raw: RawFinding): string {
  return raw.location || raw.datacenter || raw.home_location || '';
}

export function extractMonthlyCost(raw: RawFinding): number | null {
  return raw.monthly_cost ?? raw.est_monthly_waste_eur ?? null;
}

export function extractMonthlySaving(raw: RawFinding): number | null {
  return raw.monthly_saving ?? null;
}

export function extractConfidence(raw: RawFinding): number | null {
  return raw.confidence ?? null;
}

export function extractCurrency(raw: RawFinding): string | null {
  return raw.currency ?? null;
}

function runCommand(
  command: string,
  env: Record<string, string>,
  timeoutMs = 1200000,
  extraArgs: string[] = []
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      BTG_PATH,
      ['analyze', command, '--output', 'json', ...extraArgs],
      { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Non-zero exit but may still have output
          if (stdout && stdout.trim()) {
            resolve(stdout);
          } else {
            reject(new Error(`[${command}] ${stderr || err.message}`));
          }
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

/** Pull the first numeric total_* field from a summary object. */
function extractResourceCount(summary: Record<string, unknown> | undefined): number {
  if (!summary) return 0;
  const keys = [
    'total_accounts', 'total_registries', 'total_nsgs', 'total_vaults',
    'total_function_apps', 'total_pips', 'total_plans', 'total_resource_groups',
    'total_assignments', 'total_apps', 'total_environments', 'total_flows',
    'total_workspaces', 'total_credentials', 'total_skus',
    'total_servers', 'total_volumes', 'total_floating_ips',
    'total_firewalls', 'total_certificates',
  ];
  for (const k of keys) {
    if (typeof summary[k] === 'number' && (summary[k] as number) > 0) return summary[k] as number;
  }
  return 0;
}

export interface CommandResult {
  findings: NormalizedFinding[];
  resourcesScanned: number;
}

export async function runSingleCommand(
  command: Command,
  credentials: Credentials,
  hcloudToken?: string
): Promise<CommandResult> {
  // Hetzner auth is a single project token, not an Azure-AD service
  // principal — it doesn't fit the Credentials shape at all, so it gets its
  // own env var rather than being shoehorned into tenantId/clientId/etc.
  const env: Record<string, string> = isHetznerCommand(command)
    ? { HCLOUD_TOKEN: hcloudToken || process.env.HCLOUD_TOKEN || '' }
    : {
        AZURE_TENANT_ID: credentials.tenantId,
        AZURE_CLIENT_ID: credentials.clientId,
        AZURE_CLIENT_SECRET: credentials.clientSecret,
        AZURE_SUBSCRIPTION_ID: credentials.subscriptionId,
      };

  // `idle` sleeps 1s per resource plus 2-3 serialized Azure API calls each,
  // across up to 8 resource types — on large subscriptions this can exceed
  // the default 20-minute timeout, so give it more headroom.
  const stdout = command === 'idle'
    ? await runCommand(command, env, 2400000)
    : await runCommand(command, env);
  const service = SERVICE_LABELS[command] || command;

  let parsed: { findings?: RawFinding[]; summary?: Record<string, unknown> };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { findings: [], resourcesScanned: 0 };
  }

  const resourcesScanned = extractResourceCount(parsed.summary);
  if (!parsed.findings || !Array.isArray(parsed.findings)) return { findings: [], resourcesScanned };

  return {
    resourcesScanned,
    findings: parsed.findings.map((f: RawFinding): NormalizedFinding => ({
      service,
      resource: extractResource(f),
      environment: f.environment || '',
      severity: f.severity || 'Info',
      category: f.category || '',
      description: f.description || '',
      recommendation: f.recommendation || '',
      owner: f.owner || '',
      location: extractLocation(f),
      monthly_cost: extractMonthlyCost(f),
      monthly_saving: extractMonthlySaving(f),
      confidence: extractConfidence(f),
      reasoning: f.reasoning || '',
      currency: extractCurrency(f),
    })),
  };
}

export interface HetznerCostResult {
  currency: string;
  totalMonthly: number;
  byCategory: Record<string, number>;
  byType: Record<string, { count: number; monthly_total: number }>;
  unpriced?: string[];
  estimate: boolean;
  note: string;
}

interface RawHetznerCostReport {
  currency?: string;
  total_monthly?: number;
  by_category?: Record<string, number>;
  by_type?: Record<string, { count: number; monthly_total: number }>;
  unpriced?: string[];
  estimate?: boolean;
  note?: string;
}

/**
 * Parses and validates the `analyze hetzner-cost` JSON output.
 *
 * A cost path must never quietly report 0 — this feature exists specifically
 * because the previous code silently assumed EUR and produced wrong figures.
 * `currency` and `total_monthly` are therefore required and validated: if the
 * CLI's output shape ever changes (a renamed field, a format change), this
 * throws a clear error naming what's missing rather than falling back to a
 * spurious "$0, EUR" report that would then get persisted and render on the
 * dashboard as though Hetzner costs nothing. `by_category`/`by_type`
 * defaulting to `{}` is fine — an account with no resources of a kind
 * legitimately has none — but the two required fields above are never
 * legitimately absent from a well-formed report.
 *
 * Exported as a standalone pure function (rather than inlined in
 * runHetznerCostReport) so it can be unit-tested directly without shelling
 * out — matching how the rest of this execFile-based file stays untested at
 * the process-spawning layer.
 */
export function parseHetznerCostReport(stdout: string): HetznerCostResult {
  const parsed: RawHetznerCostReport = JSON.parse(stdout);

  if (typeof parsed.currency !== 'string' || parsed.currency.trim() === '') {
    throw new Error(`hetzner-cost: missing or invalid "currency" in output (got ${JSON.stringify(parsed.currency)})`);
  }
  if (typeof parsed.total_monthly !== 'number' || Number.isNaN(parsed.total_monthly)) {
    throw new Error(`hetzner-cost: missing or invalid "total_monthly" in output (got ${JSON.stringify(parsed.total_monthly)})`);
  }

  return {
    currency: parsed.currency,
    totalMonthly: parsed.total_monthly,
    byCategory: parsed.by_category || {},
    byType: parsed.by_type || {},
    unpriced: parsed.unpriced,
    estimate: parsed.estimate ?? true,
    note: parsed.note || '',
  };
}

/**
 * Runs `analyze hetzner-cost` and parses its cost-report shape directly.
 *
 * This deliberately does NOT go through runSingleCommand: that function
 * parses `{ findings: [], summary: {} }` and maps findings, but
 * hetzner-cost's output is a completely different shape —
 * `{ currency, total_monthly, by_category, by_type, unpriced, estimate,
 * note }`. Routing it through runSingleCommand would parse successfully,
 * find no `findings` array, and silently return zero findings instead of
 * erroring — the cost data would just be dropped.
 *
 * Hetzner auth is the single HCLOUD_TOKEN env var, not the Azure
 * service-principal set — mirrors the isHetznerCommand branch in
 * runSingleCommand above.
 */
export async function runHetznerCostReport(hcloudToken?: string): Promise<HetznerCostResult> {
  const env: Record<string, string> = { HCLOUD_TOKEN: hcloudToken || process.env.HCLOUD_TOKEN || '' };
  const stdout = await runCommand('hetzner-cost', env);
  return parseHetznerCostReport(stdout);
}

export interface HetznerReconstructedPoint { day: string; total_monthly: number; currency: string }

/** Runs the CLI's run-rate reconstruction, replaying resource creation dates
 * against today's list prices to derive past days.
 *
 * This exists because Hetzner has no spend history to fetch — without it the
 * chart is empty until enough days accumulate naturally. The figures are
 * derived, not observed, and are stored flagged as such. */
export async function runHetznerCostHistory(days: number, hcloudToken?: string): Promise<HetznerReconstructedPoint[]> {
  const env: Record<string, string> = { HCLOUD_TOKEN: hcloudToken || process.env.HCLOUD_TOKEN || '' };
  const stdout = await runCommand('hetzner-cost', env, 1200000, ['--history-days', String(days)]);
  const parsed = JSON.parse(stdout) as { history?: HetznerReconstructedPoint[] };
  if (!Array.isArray(parsed.history)) {
    throw new Error('hetzner-cost: --history-days produced no "history" array');
  }
  return parsed.history;
}

export async function runAllCommands(
  commands: Command[],
  credentials: Credentials,
  ppCredentials?: Credentials,
  hcloudToken?: string,
  // Typed as Command, not string: runAllCommands only ever invokes this with
  // an element of `commands`. Declaring it as string forced every caller that
  // wanted to index back into that array to fail typechecking.
  onProgress?: (cmd: Command, count: number) => void
): Promise<{ findings: NormalizedFinding[]; ran: Command[]; errors: string[]; ppErrors: string[]; hetznerErrors: string[]; resourcesScanned: number }> {
  const allFindings: NormalizedFinding[] = [];
  const ran: Command[] = [];
  const errors: string[] = [];
  const ppErrors: string[] = [];
  const hetznerErrors: string[] = [];
  let resourcesScanned = 0;

  const isPP = (cmd: string): boolean =>
    PP_COMMANDS.includes(cmd as typeof PP_COMMANDS[number]);

  for (const cmd of commands) {
    const creds = isPP(cmd) ? (ppCredentials ?? credentials) : credentials;
    try {
      const result = await runSingleCommand(cmd, creds, hcloudToken);
      allFindings.push(...result.findings);
      resourcesScanned += result.resourcesScanned;
      ran.push(cmd);
      onProgress?.(cmd, result.findings.length);
    } catch (e) {
      const msg = `${cmd}: ${(e as Error).message}`;
      if (isHetznerCommand(cmd)) hetznerErrors.push(msg);
      else if (isPP(cmd)) ppErrors.push(msg);
      else errors.push(msg);
    }
  }

  return { findings: allFindings, ran, errors, ppErrors, hetznerErrors, resourcesScanned };
}
