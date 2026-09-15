import { describe, it, expect } from 'vitest';
import { createSingleFlightRunner } from './single-flight';

// Guards the scheduler's poll cycle: job durations here (an ~91-resource
// audit hitting a rate-limited API, each retry backing off) can easily
// exceed the 60s poll interval, so without this a slow cycle and the next
// tick's cycle overlap and pile concurrent Cost Management callers onto the
// same tenant-wide rate limit.
describe('createSingleFlightRunner', () => {
  it('does not invoke the wrapped function again while the first call is still in flight', async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    let resolveFirst!: () => void;

    const run = createSingleFlightRunner(async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise<void>(r => { resolveFirst = r; });
      concurrentCalls--;
    });

    const firstCall = run();
    const secondCall = run(); // fired while the first is still pending

    resolveFirst();
    await Promise.all([firstCall, secondCall]);

    expect(maxConcurrent).toBe(1);
  });

  it('runs again once the previous call has finished', async () => {
    let calls = 0;
    const run = createSingleFlightRunner(async () => { calls++; });

    await run();
    await run();

    expect(calls).toBe(2);
  });

  it('clears the in-flight flag even when the wrapped function throws', async () => {
    let calls = 0;
    const run = createSingleFlightRunner(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });

    await expect(run()).rejects.toThrow('boom');
    // A failed cycle must not wedge the flag on forever, or the scheduler
    // silently stops polling until the process restarts.
    await run();

    expect(calls).toBe(2);
  });

  it('reports whether a call is currently in flight', async () => {
    let resolveIt!: () => void;
    const run = createSingleFlightRunner(async () => {
      await new Promise<void>(r => { resolveIt = r; });
    });

    expect(run.isRunning()).toBe(false);
    const inFlight = run();
    expect(run.isRunning()).toBe(true);
    resolveIt();
    await inFlight;
    expect(run.isRunning()).toBe(false);
  });
});
