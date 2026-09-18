/** Wraps an async function so overlapping calls collapse into the call
 * already in flight, rather than stacking a second run on top of the first.
 *
 * Built for the scheduler's poll cycle: its jobs (an audit walking ~91
 * resources against a rate-limited Cost Management API, each retry backing
 * off) can easily run past the 60s poll interval, so without this guard the
 * next tick's cycle starts while the previous one is still mid-run — two
 * concurrent sets of Cost Management callers hitting the same tenant-wide
 * limit instead of one.
 *
 * Not a distributed lock and doesn't need to be — this only ever guards
 * calls within one process. */
export function createSingleFlightRunner(fn: () => Promise<void>): (() => Promise<void>) & { isRunning(): boolean } {
  let inFlight: Promise<void> | null = null;

  const run = (async (): Promise<void> => {
    if (inFlight) return inFlight;
    const promise = fn().finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
    return promise;
  }) as (() => Promise<void>) & { isRunning(): boolean };

  run.isRunning = () => inFlight !== null;
  return run;
}
