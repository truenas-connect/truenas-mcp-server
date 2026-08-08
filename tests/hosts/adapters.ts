import { ALLOWED_TOOLS } from './harness';

/**
 * A host adapter supplies exactly three things: how to point the host at the
 * fixture, how to run one non-interactive prompt, and what the host is
 * expected to advertise. Everything else — fixture, trace, assertions — is
 * the shared harness. Adding a host is an adapter plus a matrix row.
 */
export interface HostAdapter {
  name: string;
  /** Binary on PATH; the host's rows are skipped when absent. */
  command: string;
  /** argv for a single non-interactive (headless) prompt. */
  headlessArgs(mcpConfigPath: string, prompt: string): string[];
  /** argv for the interactive TUI; omit for hosts without one. */
  interactiveArgs?(mcpConfigPath: string): string[];
  /** What the host's initialize request is expected to advertise. */
  expectsElicitation: boolean;
}

export const claudeCode: HostAdapter = {
  name: 'claude-code',
  command: 'claude',
  headlessArgs: (mcpConfigPath, prompt) => [
    '-p',
    prompt,
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED_TOOLS,
    '--max-turns',
    '8',
    '--output-format',
    'json',
  ],
  interactiveArgs: (mcpConfigPath) => [
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED_TOOLS,
  ],
  expectsElicitation: true,
};

/** Verified rows only — a host earns its entry by being probed (plan:
 * "unverified rows are candidates, not claims"). Codex CLI, Goose and MCP
 * Inspector are candidates in the plan's client matrix, not yet probed. */
export const adapters: HostAdapter[] = [claudeCode];
