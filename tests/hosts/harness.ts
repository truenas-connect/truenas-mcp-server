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
  /** The fixture as one command line, for hosts that take a command rather
   * than a config file (goose's --with-extension). */
  serverCommand: string;
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
  const args = [fixture, '--config', configPath, '--trace', tracePath];
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: { truenas: { command: process.execPath, args } },
    }),
  );
  return {
    mcpConfigPath,
    tracePath,
    auditPath,
    // Hosts that take this as one string split it with shell rules, so each
    // argument is quoted — node's install path or the tmp dir containing a
    // space must not shear an argument in two.
    serverCommand: [process.execPath, ...args].map(shellQuote).join(' '),
  };
}

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", String.raw`'\''`)}'`;
}

/** The nested-session markers Claude Code sets in child sessions. Scrubbed
 * by explicit name — never by prefix, because CLAUDE_CODE_OAUTH_TOKEN is a
 * documented headless-auth credential the nightly CI path will need, and a
 * CLAUDE_CODE_* sweep would silently strip it. */
const NESTED_SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION',
]);

/** Child env with nested-session and ambient config markers scrubbed. On a
 * dev machine this suite often runs from inside a Claude Code session, whose
 * markers change host behavior. */
export function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !NESTED_SESSION_MARKERS.has(key) &&
      !key.startsWith('TRUENAS_MCP_')
    ) {
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
    error?: Record<string, unknown>;
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

/** Every elicitation answer the client returned (recv frames with an
 * `action` result). Unattended, none of these may ever be "accept". */
export function elicitationAnswers(frames: TraceFrame[]): string[] {
  return frames
    .filter((f) => f.dir === 'recv')
    .map((f) => (f.message.result as { action?: string } | undefined)?.action)
    .filter((action): action is string => action !== undefined);
}

/**
 * Per sent elicitation, whether the client's response accepted it. Hosts fail
 * closed in more than one shape — an `action` of decline/cancel, a JSON-RPC
 * error response, or no response at all — and every one of those counts as
 * not-accepted. This is the shape-agnostic form of the tier-3 invariant.
 */
export function elicitationAccepts(frames: TraceFrame[]): boolean[] {
  return frames
    .filter((f) => f.dir === 'send' && f.message.method === 'elicitation/create')
    .map((request) => {
      const response = frames.find(
        (f) =>
          f.dir === 'recv' &&
          f.message.id === request.message.id &&
          (f.message.result !== undefined || f.message.error !== undefined),
      );
      return (response?.message.result as { action?: string } | undefined)?.action === 'accept';
    });
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
