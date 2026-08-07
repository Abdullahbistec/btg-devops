import { execFile } from 'child_process';
import path from 'path';
import { AZURE_COMMANDS, PP_COMMANDS, ALL_COMMANDS, PP_SERVICE_LABELS } from './btg-commands';
import type { Command } from './btg-commands';

// Re-exported for existing server-side consumers (API routes, audit-executor.ts).
// Client components must import these from '@/lib/btg-commands' directly —
// this file is server-only (imports 'child_process') and cannot be bundled
// for the browser.
export { AZURE_COMMANDS, PP_COMMANDS, ALL_COMMANDS, PP_SERVICE_LABELS };
export type { Command };

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
}

interface RawFinding {
  severity?: string;
  category?: string;
  description?: string;
  recommendation?: string;
  owner?: string;
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
  sku_id?: string;
  // SP Expiry fields
  credential_name?: string;
  app_id?: string;
}

function extractResource(raw: RawFinding): string {
  return (
    raw.app_name || raw.account_name || raw.resource_name || raw.plan_name ||
    raw.function_app_name || raw.ip_name || raw.vault_name ||
    raw.nsg_name || raw.registry_name || raw.group_name ||
    raw.resource_group || raw.flow_name ||
    raw.workspace || raw.workspace_name || raw.sku_id || raw.credential_name || ''
  );
}

function runCommand(
  command: string,
  env: Record<string, string>,
  timeoutMs = 1200000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      BTG_PATH,
      ['analyze', command, '--output', 'json'],
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
  credentials: Credentials
): Promise<CommandResult> {
  const env = {
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
    })),
  };
}

export async function runAllCommands(
  commands: Command[],
  credentials: Credentials,
  ppCredentials?: Credentials,
  onProgress?: (cmd: string, count: number) => void
): Promise<{ findings: NormalizedFinding[]; ran: Command[]; errors: string[]; ppErrors: string[]; resourcesScanned: number }> {
  const allFindings: NormalizedFinding[] = [];
  const ran: Command[] = [];
  const errors: string[] = [];
  const ppErrors: string[] = [];
  let resourcesScanned = 0;

  const isPP = (cmd: string): boolean =>
    PP_COMMANDS.includes(cmd as typeof PP_COMMANDS[number]);

  for (const cmd of commands) {
    const creds = isPP(cmd) ? (ppCredentials ?? credentials) : credentials;
    try {
      const result = await runSingleCommand(cmd, creds);
      allFindings.push(...result.findings);
      resourcesScanned += result.resourcesScanned;
      ran.push(cmd);
      onProgress?.(cmd, result.findings.length);
    } catch (e) {
      const msg = `${cmd}: ${(e as Error).message}`;
      if (isPP(cmd)) ppErrors.push(msg);
      else errors.push(msg);
    }
  }

  return { findings: allFindings, ran, errors, ppErrors, resourcesScanned };
}
