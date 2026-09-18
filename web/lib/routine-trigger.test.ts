/**
 * Unit tests for routine-trigger.ts — the on-creation queue drain.
 *
 * Run with: npx vitest run lib/routine-trigger.test.ts
 *
 * The spawner is injected rather than vi.mock'd, so these tests exercise the
 * module's real guard state and the real argv it builds — a mocked
 * child_process would only prove the mock was called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { triggerQueueDrain, resetDrainStateForTests, buildWindowsCommandLine } from './routine-trigger';

/** Splits a built command line into its top-level quoted tokens. Anything the
 * builder failed to quote simply will not appear, which is what makes the
 * token count a real assertion rather than a formatting check. */
function quotedTokens(commandLine: string): string[] {
  return commandLine.match(/"(?:[^"]|"")*"/g) ?? [];
}

describe('buildWindowsCommandLine', () => {
  // The original bug: a separate args array was handed to spawn with
  // shell:true, which Node concatenates with plain spaces instead of
  // escaping. cmd.exe then tokenized the multi-word prompt into dozens of
  // arguments and claude received garbage, so every drain silently did
  // nothing. These tests fail if that shape ever comes back.
  it('keeps a multi-word argument as one token instead of letting cmd.exe split it', () => {
    const args = ['-p', 'drain the queue, then stop. do not ask questions', '--allowedTools', 'x'];

    const built = buildWindowsCommandLine('claude', args);
    const tokens = quotedTokens(built);

    expect(tokens).toHaveLength(1 + args.length);
    // Nothing outside a quoted token — an unquoted fragment would mean an
    // argument got torn apart at a space.
    expect(tokens.join(' ')).toBe(built);
    expect(tokens[2]).toBe('"drain the queue, then stop. do not ask questions"');
  });

  it('quotes the tool glob so cmd.exe cannot expand or split it', () => {
    const built = buildWindowsCommandLine('claude', ['--allowedTools', 'mcp__btg-devops__*']);

    expect(built).toContain('"mcp__btg-devops__*"');
  });

  it('doubles embedded double quotes so they survive the tokenizer', () => {
    const built = buildWindowsCommandLine('claude', ['say "hello" now']);

    expect(built).toBe('"claude" "say ""hello"" now"');
    expect(quotedTokens(built)).toHaveLength(2);
  });
});

describe('triggerQueueDrain', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    ['CLAUDE_DRAIN_ENABLED'].forEach(k => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
    resetDrainStateForTests();
  });

  afterEach(() => {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    resetDrainStateForTests();
  });

  it('does not spawn when CLAUDE_DRAIN_ENABLED is unset', () => {
    const calls: string[][] = [];
    const result = triggerQueueDrain({
      spawn: (cmd, args) => { calls.push([cmd, ...args]); return new Promise(() => {}); },
    });

    expect(result).toBe('skipped-disabled');
    expect(calls).toEqual([]);
  });

  it('spawns claude in print mode with the MCP tools pre-allowed when enabled', () => {
    process.env.CLAUDE_DRAIN_ENABLED = '1';
    const calls: { cmd: string; args: string[] }[] = [];

    const result = triggerQueueDrain({
      spawn: (cmd, args) => { calls.push({ cmd, args }); return new Promise(() => {}); },
    });

    expect(result).toBe('spawned');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toContain('-p');
    // Without pre-allowing the tools, a headless run blocks on a permission
    // prompt forever instead of draining anything.
    expect(calls[0].args).toContain('--allowedTools');
    expect(calls[0].args).toContain('mcp__btg-devops__*');
  });

  it('does not spawn a second drain while one is still running', () => {
    process.env.CLAUDE_DRAIN_ENABLED = '1';
    let spawnCount = 0;
    // A promise that never settles stands in for a drain still in flight.
    const spawn = () => { spawnCount++; return new Promise<void>(() => {}); };

    expect(triggerQueueDrain({ spawn })).toBe('spawned');
    expect(triggerQueueDrain({ spawn })).toBe('skipped-running');
    expect(spawnCount).toBe(1);
  });

  it('allows a new drain once the previous one has finished', async () => {
    process.env.CLAUDE_DRAIN_ENABLED = '1';
    let spawnCount = 0;
    const spawn = () => { spawnCount++; return Promise.resolve(); };

    expect(triggerQueueDrain({ spawn })).toBe('spawned');
    // Let the resolved spawn promise clear the in-flight flag.
    await new Promise(r => setImmediate(r));

    expect(triggerQueueDrain({ spawn })).toBe('spawned');
    expect(spawnCount).toBe(2);
  });

  it('reports an error instead of throwing when claude is not on PATH', () => {
    process.env.CLAUDE_DRAIN_ENABLED = '1';
    const spawn = () => { throw new Error('spawn claude ENOENT'); };

    // A missing binary must never propagate into the HTTP response that
    // queued the request — the row stays pending and is still drainable.
    expect(triggerQueueDrain({ spawn })).toBe('skipped-error');
  });

  it('clears the in-flight flag when a drain rejects, so later drains still run', async () => {
    process.env.CLAUDE_DRAIN_ENABLED = '1';
    let spawnCount = 0;
    const spawn = () => { spawnCount++; return Promise.reject(new Error('claude exited 1')); };

    expect(triggerQueueDrain({ spawn })).toBe('spawned');
    await new Promise(r => setImmediate(r));

    expect(triggerQueueDrain({ spawn })).toBe('spawned');
    expect(spawnCount).toBe(2);
  });
});
