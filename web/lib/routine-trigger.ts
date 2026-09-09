import { spawn as childSpawn } from 'child_process';

/** Fire-and-forget launcher for one queue drain. Resolves when the drain
 * process exits, so the caller can clear its in-flight flag; injected in
 * tests so the guard logic can be exercised without launching an agent. */
export type DrainSpawner = (cmd: string, args: string[]) => Promise<void>;

export type DrainResult = 'skipped-disabled' | 'skipped-running' | 'skipped-error' | 'spawned';

/** Pre-allowing the MCP tools is not optional: a headless `claude -p` run
 * that hits a permission prompt blocks forever instead of draining. */
const ALLOWED_TOOLS = 'mcp__btg-devops__*';

const DRAIN_PROMPT =
  'Drain the dashboard request queues via the btg-devops MCP tools, without asking any clarifying questions. ' +
  'First call list_pending_requests. For each pending request, call get_audit_data with its request_id, ' +
  'write a 3-5 sentence executive risk summary of the findings context returned, then call save_analysis with ' +
  'that request_id and your summary — or an error message instead of a summary if the analysis could not be ' +
  'completed. Then call list_pending_cost_requests and call fetch_cost_data for each pending request; that tool ' +
  'does the whole refresh itself, so nothing further is needed for those. ' +
  'If either list returns zero pending requests, that is a normal successful outcome — finish immediately and ' +
  'do not fabricate anything.';

// Module-level, deliberately: this guards against one dashboard process
// stacking concurrent agent runs when Summarize is clicked repeatedly. It is
// not a distributed lock and does not need to be — the drain is idempotent
// (a second run just finds the queue already empty).
let draining = false;

/** Resets the in-flight flag. Exported for tests only, so each case starts
 * from a known state; nothing in the request path should call this. */
export function resetDrainStateForTests(): void {
  draining = false;
}

function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_DRAIN_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** Launches `claude -p` to drain the pending queues, if enabled and not
 * already running. Never throws and never blocks: every failure path returns
 * a status and leaves the queued row pending, still drainable by a later
 * trigger. Off unless CLAUDE_DRAIN_ENABLED is set — see the security note in
 * docs/ai-analysis-routine-setup.md: this spawns an agent with tool access in
 * response to an HTTP request, which is only appropriate on a local machine.
 */
export function triggerQueueDrain(deps?: { spawn?: DrainSpawner }): DrainResult {
  if (!isEnabled()) return 'skipped-disabled';
  if (draining) return 'skipped-running';

  const spawn = deps?.spawn ?? defaultSpawn;
  draining = true;
  try {
    const finished = spawn('claude', ['-p', DRAIN_PROMPT, '--allowedTools', ALLOWED_TOOLS]);
    // Clear on both settle paths, or one failed drain wedges the flag on and
    // no later request ever triggers again.
    finished.then(
      () => { draining = false; },
      (e: unknown) => {
        draining = false;
        console.warn('[routine-trigger] drain exited non-zero:', e instanceof Error ? e.message : e);
      }
    );
    return 'spawned';
  } catch (e) {
    draining = false;
    console.warn('[routine-trigger] could not start a drain:', e instanceof Error ? e.message : e);
    return 'skipped-error';
  }
}

function defaultSpawn(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // shell:true on Windows because `claude` is a .cmd shim there, which
    // CreateProcess cannot execute directly. Every argument here is a
    // module constant, never caller- or request-supplied.
    const child = childSpawn(cmd, args, {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    );
  });
}
