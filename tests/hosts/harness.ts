import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared, host-agnostic core of the tier-3 harness.
 * The server under test is always the tier-2 fixture (real runServer from
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

/** Registered fixture systems, in config (and therefore registry) order.
 * Two, so tier-3 sessions exercise a real fan-out. Naming constraints: no
 * name may be a prefix of another — the screen assertions are substring
 * checks in both directions — and ABSENT_SYSTEM must stay shaped like these
 * while never being registered. */
export const FIXTURE_SYSTEMS = ['nas-a', 'nas-b'];

/** Shape control for the tier-3 render assertion: named like a real system,
 * never registered, so it can only appear on screen if a positive check
 * matches on a substring accident. The stronger control — a system that IS
 * registered but absent from the plan — lives in interactive.spec.ts's
 * narrowed-plan scenario. */
export const ABSENT_SYSTEM = 'nas-c';

export interface FixturePaths {
  mcpConfigPath: string;
  tracePath: string;
  auditPath: string;
  /** Where a host may write its own startup/MCP log. Ours records the wire;
   * this records the host's side of it, which is the only place a failure to
   * connect at all can be explained from. */
  hostLogPath: string;
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
  const hostLogPath = join(dir, 'host.log');
  writeFileSync(
    configPath,
    JSON.stringify({
      systems: FIXTURE_SYSTEMS.map((name) => ({
        name,
        host: '192.0.2.1',
        username: 'u',
        apiKey: 'k',
      })),
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
    hostLogPath,
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
 * by explicit name — never by prefix: CLAUDE_CODE_OAUTH_TOKEN is a documented
 * headless-auth credential (the subscription-backed alternative to
 * ANTHROPIC_API_KEY, which the nightly uses), and a CLAUDE_CODE_* sweep would
 * silently strip it for anyone authenticating that way. */
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

/**
 * Whether the host has finished connecting to OUR server: it has sent
 * `notifications/initialized`, the protocol's own end-of-handshake signal,
 * which a client emits exactly once after `initialize` succeeds and before
 * any other request.
 *
 * This is the interactive suite's readiness gate, and it is deliberately not a
 * screen pattern. A TUI's banner is the host's own chrome — it changes with
 * their releases, carries no promise to us, and when it stops matching the
 * failure names the banner rather than the cause. Measured 2026-09-10 against
 * claude-code 2.1.260: this fires at ~2s, where the screen gate it replaced
 * allowed 120s and then reported the wrong thing.
 *
 * It is also host-agnostic, so both adapters share one gate instead of each
 * carrying a regex that can go stale on its own schedule. The signal has to be
 * the handshake and not a later request: an earlier version gated on
 * `tools/list`, which claude-code sends at startup but goose defers until the
 * first prompt is submitted — and the driver does not submit the prompt until
 * this gate opens, so goose deadlocked and was reported as never having
 * connected (observed 2026-09-11, goose-cli against the tier-2 fixture:
 * initialize, notifications/initialized, prompts/list, then nothing for the
 * full 120s budget).
 */
export function hostConnected(tracePath: string): boolean {
  return readTrace(tracePath).some(
    (f) => f.dir === 'recv' && f.message.method === 'notifications/initialized',
  );
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
