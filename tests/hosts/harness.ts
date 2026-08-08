import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared, host-agnostic core of the tier-3 harness (testing-plan Phase 5).
 * The server under test is always the Phase 4 fixture (real runServer from
 * dist/, fake ClientFactory), and every assertion reads our server's --trace
 * or audit JSONL — never model prose, which differs run to run while the
 * frame sequence stays identical.
 */

export const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = join(root, 'tests', 'fixtures', 'stdio-server.mjs');

/** The one prompt every host gets. Wording matters less than determinism of
 * the frames it produces: one read-only call, then one mutating call. */
export const SESSION_PROMPT =
  'Use the truenas MCP tools, two calls, no questions: first call ' +
  'storage_pool_status with systems set to "all"; then call snapshots_create ' +
  'with dataset "tank/data", name "probe", systems "all".';

export const ALLOWED_TOOLS = 'mcp__truenas__storage_pool_status,mcp__truenas__snapshots_create';

export interface FixturePaths {
  mcpConfigPath: string;
  tracePath: string;
  auditPath: string;
}

/** Writes the server config and an MCP config pointing the host at the
 * fixture; returns the paths the assertions read. */
export function setUpFixture(dir: string): FixturePaths {
  const configPath = join(dir, 'config.json');
  const auditPath = join(dir, 'audit.jsonl');
  const tracePath = join(dir, 'trace.jsonl');
  const mcpConfigPath = join(dir, 'mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      systems: [{ name: 'nas-a', host: '192.0.2.1', username: 'u', apiKey: 'k' }],
      auditLog: auditPath,
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        truenas: {
          command: process.execPath,
          args: [fixture, '--config', configPath, '--trace', tracePath],
        },
      },
    }),
  );
  return { mcpConfigPath, tracePath, auditPath };
}

/** Child env with nested-session and ambient config markers scrubbed. On a
 * dev machine this suite often runs from inside a Claude Code session, and
 * CLAUDE* leakage changes host behavior. */
export function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('CLAUDE') && !key.startsWith('TRUENAS_MCP_')) {
      env[key] = value;
    }
  }
  env['TERM'] = 'xterm-256color';
  return env;
}

export function hostOnPath(command: string): boolean {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

export interface TraceFrame {
  dir: 'send' | 'recv';
  message: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
  };
}

export function readTrace(tracePath: string): TraceFrame[] {
  if (!existsSync(tracePath)) {
    return [];
  }
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceFrame);
}

export function readAudit(auditPath: string): { tool: string; phase: string }[] {
  if (!existsSync(auditPath)) {
    return [];
  }
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string; phase: string });
}

/** Polls until `predicate` holds or `timeoutMs` passes; callers assert after. */
export async function until(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
