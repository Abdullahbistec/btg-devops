export async function register() {
  // Only run in the Node.js server process — this hook also fires for the Edge
  // runtime (middleware), which can't run the scheduler (needs node:sqlite,
  // child_process, etc.).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
  }
}
