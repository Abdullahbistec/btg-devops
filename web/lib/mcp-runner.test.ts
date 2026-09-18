import { describe, it, expect } from 'vitest';
import { shouldAutoStartMcp, buildMcpArgs, resolveDashboardSelfUrl } from './mcp-runner';

describe('shouldAutoStartMcp', () => {
  // Mirrors isInternalServiceRequest's own convention (web/lib/auth.ts):
  // unset = feature not configured, never auto-activate. Auto-starting a
  // listener nobody asked for is worse than not starting one someone wanted.
  it('is false when both tokens are unset', () => {
    expect(shouldAutoStartMcp({})).toBe(false);
  });

  it('is false when only the bearer token is set', () => {
    expect(shouldAutoStartMcp({ MCP_BEARER_TOKEN: 'abc' })).toBe(false);
  });

  it('is false when only the internal token is set', () => {
    expect(shouldAutoStartMcp({ MCP_INTERNAL_TOKEN: 'abc' })).toBe(false);
  });

  it('is false when a token is set to an empty string', () => {
    expect(shouldAutoStartMcp({ MCP_BEARER_TOKEN: '', MCP_INTERNAL_TOKEN: 'abc' })).toBe(false);
  });

  it('is true once both tokens are non-empty', () => {
    expect(shouldAutoStartMcp({ MCP_BEARER_TOKEN: 'abc', MCP_INTERNAL_TOKEN: 'xyz' })).toBe(true);
  });
});

describe('resolveDashboardSelfUrl', () => {
  it('defaults to localhost on the Next.js PORT', () => {
    expect(resolveDashboardSelfUrl({ PORT: '3000' })).toBe('http://localhost:3000');
  });

  it('falls back to port 3000 when PORT is unset', () => {
    expect(resolveDashboardSelfUrl({})).toBe('http://localhost:3000');
  });

  it('prefers an explicit DASHBOARD_BASE_URL over the PORT guess', () => {
    expect(resolveDashboardSelfUrl({ PORT: '3000', DASHBOARD_BASE_URL: 'https://internal.example.com' }))
      .toBe('https://internal.example.com');
  });
});

describe('buildMcpArgs', () => {
  it('builds the exact argv the CLI expects for --http mode', () => {
    expect(buildMcpArgs(':8090', 'http://localhost:3000')).toEqual([
      'mcp', '--http', '--addr', ':8090', '--dashboard-url', 'http://localhost:3000',
    ]);
  });
});
