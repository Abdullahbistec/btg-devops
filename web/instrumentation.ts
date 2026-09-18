/** Whether the in-process scheduler should run. The scheduler polls every 60s
 * and makes live Azure/Hetzner cost calls, so it must NOT run during local
 * `npm run dev` by default (it hammers tenant-wide rate limits and pollutes
 * logs). Rules:
 *   - ENABLE_SCHEDULER set explicitly ('1'/'true' → on, '0'/'false' → off) wins.
 *   - Otherwise: on in production, off in development.
 * Note: this is still a single-instance switch — a horizontally-scaled deploy
 * would run one scheduler per instance. See docs/backend-engineering-review
 * (E-4) for the advisory-lock follow-up. */
export function schedulerEnabled(): boolean {
  const flag = (process.env.ENABLE_SCHEDULER ?? '').toLowerCase();
  if (flag === '1' || flag === 'true')  return true;
  if (flag === '0' || flag === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export async function register() {
  // Next.js also builds an Edge-runtime bundle of this file (middleware.ts
  // runs on Edge, and register() is invoked once per runtime the app
  // instantiates). Everything below imports node:child_process/path/crypto
  // transitively (scheduler -> db/btg-runner, mcp-runner -> child_process),
  // none of which exist on Edge.
  //
  // This exact shape -- `if (process.env.NEXT_RUNTIME === 'nodejs') { ... }`
  // as ONE block, not an early return -- is the pattern Next's build tooling
  // recognizes to exclude the block's imports from the Edge bundle entirely.
  // An early-return guard (`if (x !== 'nodejs') return;`) does NOT match that
  // pattern: the dynamic imports after it still get statically resolved for
  // the Edge target and the build fails with "Can't resolve 'child_process'"
  // (etc.), even though that code never actually runs there. Keep this as a
  // single literal `if (process.env.NEXT_RUNTIME === 'nodejs') { ... }` block.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (schedulerEnabled()) {
      const { startScheduler } = await import('@/lib/scheduler');
      startScheduler();
    }

    // Unlike the scheduler, this isn't gated on production vs dev — it's an
    // idle listener until something calls it, and gating it the same way
    // would mean a second manual terminal is still needed in dev, which is
    // exactly what this exists to remove. See web/lib/mcp-runner.ts for the
    // real gate (both MCP tokens must be configured).
    const { startMcpServer } = await import('@/lib/mcp-runner');
    await startMcpServer();
  }
}
