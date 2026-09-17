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
  // Only run in the Node.js server process — this hook also fires for the Edge
  // runtime (middleware), which can't run the scheduler (needs node:sqlite,
  // child_process, etc.).
  if (process.env.NEXT_RUNTIME === 'nodejs' && schedulerEnabled()) {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
  }
}
