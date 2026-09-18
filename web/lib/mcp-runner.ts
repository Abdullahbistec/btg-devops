import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';

// Deliberately NOT imported from btg-runner.ts, even though that file
// exports the identical constant: btg-runner.ts pulls in the full
// Azure/PP/Hetzner command tables (btg-commands.ts) as part of its module
// graph, and instrumentation.ts (which calls startMcpServer() below) is
// bundled separately for both the Node.js and Edge runtimes. Importing that
// larger graph from here broke the Edge-runtime bundle with "Module not
// found: Can't resolve 'child_process'" even though this code only ever
// executes on the Node.js side (see the NEXT_RUNTIME check in
// instrumentation.ts) — webpack still has to resolve the import graph for
// both bundles. Keep this resolution formula in sync with btg-runner.ts's
// BTG_PATH if that one ever changes.
const BTG_PATH = process.env.BTG_DEVOPS_PATH
  ? path.resolve(process.cwd(), process.env.BTG_DEVOPS_PATH)
  : path.resolve(process.cwd(), '..', 'btg-devops.exe');

const DEFAULT_ADDR = ':8090';
const RESTART_DELAY_MS = 5000;

/** Whether to auto-start `btg-devops mcp --http` alongside the dashboard.
 *
 * Gated on both tokens being present, not on NODE_ENV — unlike the
 * scheduler (which hits live rate-limited Azure/Hetzner APIs and so
 * defaults off in dev), an idle MCP listener costs nothing until something
 * actually calls it. The real gate is the same one isInternalServiceRequest
 * (web/lib/auth.ts) already uses: unset tokens mean the feature was never
 * configured, so nothing should activate on its own. */
export function shouldAutoStartMcp(env: Record<string, string | undefined>): boolean {
  return Boolean(env.MCP_BEARER_TOKEN) && Boolean(env.MCP_INTERNAL_TOKEN);
}

/** The URL the MCP server should call back into for its own internal API
 * calls (get_audit_data, save_analysis, ...). Defaults to this same Next.js
 * process's own port rather than a hardcoded 3000, since PORT is what
 * `next start`/Docker actually binds to. */
export function resolveDashboardSelfUrl(env: Record<string, string | undefined>): string {
  if (env.DASHBOARD_BASE_URL) return env.DASHBOARD_BASE_URL;
  return `http://localhost:${env.PORT || '3000'}`;
}

export function buildMcpArgs(addr: string, dashboardUrl: string): string[] {
  return ['mcp', '--http', '--addr', addr, '--dashboard-url', dashboardUrl];
}

/** Resolves once the given TCP port already has something listening on it —
 * checked before spawning so a manually-started MCP server (or a stray one
 * left over from a previous process) is reused instead of fighting a second
 * instance over the same port.
 *
 * This connects to the port rather than trying to bind it ourselves. A
 * bind-based check ("can I also listen here?") is not reliable evidence of
 * anything on Windows — a first live run of this code passed its own
 * self-bind check while a real process was already listening on the exact
 * same address, and the Go server's subsequent real bind then failed with
 * the OS's actual "address already in use" error. Attempting a genuine
 * connection is what a client would actually do, so it can't disagree with
 * reality the way a second bind attempt can. */
function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

function parsePort(addr: string): number | null {
  const match = addr.match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

let child: ChildProcess | null = null;
let stopping = false;

function spawnMcpServer(addr: string, dashboardUrl: string): void {
  if (stopping) return;
  child = spawn(BTG_PATH, buildMcpArgs(addr, dashboardUrl), {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[mcp] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[mcp] ${d}`));

  child.on('error', (err) => {
    console.error('[mcp] failed to start the MCP server (checked BTG_DEVOPS_PATH / ../btg-devops):', err.message);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.warn(`[mcp] server exited (code=${code} signal=${signal}) — restarting in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(() => { void spawnMcpServer(addr, dashboardUrl); }, RESTART_DELAY_MS);
  });
}

let started = false;

/** Starts `btg-devops mcp --http` as a child process of the dashboard itself,
 * so Summarize's async drain never needs a second terminal window — see
 * docs/ai-analysis-routine-setup.md for what this replaces. Idempotent
 * (safe across Next.js dev-mode hot reloads); a no-op if the required
 * tokens were never configured, or if something is already listening on
 * the target port (reused rather than fought over). */
export async function startMcpServer(): Promise<void> {
  if (started) return;
  started = true;

  if (!shouldAutoStartMcp(process.env)) {
    console.log('[mcp] MCP_BEARER_TOKEN / MCP_INTERNAL_TOKEN not both set — not starting the MCP server automatically. Set both in web/.env.local to enable Summarize\'s async drain.');
    return;
  }

  const addr = process.env.MCP_ADDR || DEFAULT_ADDR;
  const port = parsePort(addr);
  if (port !== null && await portInUse(port)) {
    console.log(`[mcp] something is already listening on ${addr} — reusing it instead of starting a second instance`);
    return;
  }

  const dashboardUrl = resolveDashboardSelfUrl(process.env);
  console.log(`[mcp] starting MCP server automatically on ${addr} (dashboard-url ${dashboardUrl})`);
  spawnMcpServer(addr, dashboardUrl);
}
