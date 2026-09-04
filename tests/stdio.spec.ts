import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stream } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Tier 2b: a real MCP session, over real stdio pipes, against the built
 * artifact. The fixture runs the exported runServer from
 * dist/ with only the ClientFactory substituted (its injectable seam), so the
 * wiring under test — credential provider, registry, gate, audit, trace — is
 * exactly what the production binary runs.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(root, 'tests', 'fixtures', 'stdio-server.mjs');

beforeAll(() => {
  if (!existsSync(join(root, 'dist', 'index.js'))) {
    throw new Error('dist/index.js not found — run "yarn build" before "yarn test:dist"');
  }
});

/** Env for the child with ambient TrueNAS variables scrubbed. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('TRUENAS_MCP_')) {
      env[key] = value;
    }
  }
  return env;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnmcp-stdio-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface ConfigOptions {
  /** Registered systems, in config (and therefore registry) order. The
   * default stays N=1 so single-system coverage remains in CI — a tested
   * configuration, not a promise. */
  systems?: string[];
  requireElicitation?: boolean;
}

function writeConfig(options: ConfigOptions = {}): { configPath: string; auditPath: string } {
  const configPath = join(dir, 'config.json');
  const auditPath = join(dir, 'audit.jsonl');
  writeFileSync(
    configPath,
    JSON.stringify({
      systems: (options.systems ?? ['nas-a']).map((name) => ({
        name,
        host: '192.0.2.1',
        username: 'u',
        apiKey: 'k',
      })),
      auditLog: auditPath,
      ...(options.requireElicitation !== undefined
        ? { requireElicitation: options.requireElicitation }
        : {}),
    }),
    { mode: 0o600 },
  );
  return { configPath, auditPath };
}

/** Connects an SDK client to a freshly spawned fixture; close() ends the
 * session and the child. The session e2e test below keeps its hand-rolled
 * transport because it exercises SIGTERM shutdown and reads stderr. */
async function connectSession(args: string[]): Promise<{ client: Client; close(): Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture, ...args],
    env: childEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'tier2-suite', version: '0.0.0' }, {});
  await client.connect(transport);
  // Drain stderr so a chatty child can never stall on a full pipe; the
  // tests using this helper assert nothing on it.
  transport.stderr?.on('data', () => {});
  return { client, close: () => client.close() };
}

/**
 * The JSON results array out of a tool result's text body. The per-system
 * results are the pretty-printed JSON block: the only part of the body whose
 * '[' and ']' each start a line, or the single line '[]'. Anything before it
 * is a human-facing prefix; anything after it is the tool's result guidance,
 * which the server appends the first time a tool answers in a session. Never
 * "the first [" or "the rest of the text", which would silently couple parsing
 * to both surrounding prose blocks staying bracket-free.
 */
function parseResults(result: CallToolResult): unknown {
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  const match = /^(?:\[\]|\[[\s\S]*?^\])/m.exec(text);
  if (match === null) {
    throw new Error(`No results block in tool result body:\n${text}`);
  }
  return JSON.parse(match[0]);
}

function collect(stream: Stream | null): { text(): string } {
  const chunks: Buffer[] = [];
  stream?.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { text: () => Buffer.concat(chunks).toString() };
}

/** Polls until `predicate` holds or ~5s pass; the last check still asserts. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('stdio session (SDK-driven)', () => {
  it('handshake, tools/list, read-only round-trip, default mutating refusal, banner, trace, audit survives shutdown', async () => {
    const { configPath, auditPath } = writeConfig();
    const tracePath = join(dir, 'trace.jsonl');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture, '--config', configPath, '--trace', tracePath],
      env: childEnv(),
      stderr: 'pipe',
    });
    const stderr = collect(transport.stderr);
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    const client = new Client({ name: 'tier2-suite', version: '0.0.0' }, {});

    try {
      // Initialize handshake — connect() resolves only after it completes.
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('truenas-mcp-server');

      // tools/list advertises the real default catalog.
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('storage_pool_status');
      expect(names).toContain('snapshots_create');

      // Read-only round-trip through registry, executor and the fake client.
      const result = await client.callTool({
        name: 'storage_pool_status',
        arguments: { systems: 'all' },
      });
      expect((result as CallToolResult).isError).toBeUndefined();
      expect(parseResults(result as CallToolResult)).toEqual([
        {
          system: 'nas-a',
          status: 'SUCCESS',
          value: [
            {
              name: 'tank',
              status: 'ONLINE',
              healthy: true,
              size_bytes: 100,
              allocated_bytes: 40,
              free_bytes: 60,
              // The fixture answers no feature-flag read, and the core reports
              // "not established" as null rather than as false.
              feature_flags_current: null,
            },
          ],
        },
      ]);

      // Mutating call refused under the default: this SDK client does not
      // advertise elicitation, and the config leaves requireElicitation unset.
      const refused = await client.callTool({
        name: 'snapshots_create',
        arguments: { dataset: 'tank/data', name: 'before', systems: 'all' },
      });
      expect((refused as CallToolResult).isError).toBe(true);
      const refusal = ((refused as CallToolResult).content[0] as { text: string }).text;
      expect(refusal).toContain('does not support elicitation');
      expect(refusal).not.toContain('Confirmation token');

      // The startup banner went to stderr, never stdout.
      await until(() => stderr.text().includes('serving nas-a'));
      expect(stderr.text()).toMatch(/truenas-mcp-server \d+\.\d+\.\d+: serving nas-a/);
      expect(stderr.text()).toContain(`Tracing MCP frames to ${tracePath}`);

      // --trace captured both directions, including the initialize handshake
      // (the no-await-after-connect invariant; deterministic over real stdio).
      await until(() => readFileSync(tracePath, 'utf8').includes('"initialize"'));
      const frames = readFileSync(tracePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { dir: 'recv' | 'send'; message: { method?: string } });
      expect(frames.some((f) => f.dir === 'recv' && f.message.method === 'initialize')).toBe(true);
      expect(frames.some((f) => f.dir === 'recv' && f.message.method === 'tools/call')).toBe(true);
      expect(frames.some((f) => f.dir === 'send')).toBe(true);
    } finally {
      // SIGTERM (not transport close) so the shutdown path under test runs.
      if (transport.pid !== null) {
        process.kill(transport.pid, 'SIGTERM');
      }
      await closed;
      await client.close();
    }

    // Audit events survive to disk across a SIGTERM shutdown: the read
    // fan-out and the refused call's plan phase are both present. This does
    // NOT exercise shutdown's drain of an in-flight write — after several
    // round-trips both events landed long before the signal, and forcing a
    // write to be in flight at signal time would be a racy test. The drain
    // logic itself is unit-tested in shutdown.spec.ts.
    const audit = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
    const events = audit.map((line) => JSON.parse(line) as { tool: string; phase: string });
    expect(events.some((e) => e.tool === 'storage_pool_status' && e.phase === 'read')).toBe(true);
    expect(events.some((e) => e.tool === 'snapshots_create' && e.phase === 'plan')).toBe(true);
  }, 30_000);
});

describe('result guidance', () => {
  it('arrives with the first data-bearing result of a real catalog tool, after the JSON, and only once', async () => {
    const { configPath } = writeConfig();
    const session = await connectSession(['--config', configPath]);
    try {
      const call = async (): Promise<string> => {
        const result = (await session.client.callTool({
          name: 'share_access',
          arguments: { share: '/mnt/tank/data', systems: 'all' },
        })) as CallToolResult;
        expect(result.isError).toBeUndefined();
        return (result.content[0] as { type: 'text'; text: string }).text;
      };

      const first = await call();
      // The data is intact and parses as before: the guidance follows it.
      expect(parseResults({ content: [{ type: 'text', text: first }] })).toMatchObject([
        {
          system: 'nas-a',
          status: 'SUCCESS',
          value: { protocol: 'NFS', id: 1, name: null, path: '/mnt/tank/data', failures: [] },
        },
      ]);
      const heading = '\n\nHow to read share_access results (sent once per session';
      expect(first).toContain(heading);
      expect(first.indexOf(heading)).toBeGreaterThan(first.search(/^\]/m));
      // The opening of the base's own guidance for this tool, so a base
      // revision that stops attaching it — or attaches something else — fails
      // here rather than leaving the tolerant parser green.
      expect(first.slice(first.indexOf(heading))).toContain(
        '`failures` reports a protocol whose share list could not be read',
      );

      const second = await call();
      expect(second).not.toContain('How to read');
      expect(second).not.toContain('`failures` reports a protocol');
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe('multi-system fan-out', () => {
  it('partial fan-out failure crosses stdio as data: per-system entries in registry order, ERROR alongside SUCCESS', async () => {
    const { configPath } = writeConfig({ systems: ['nas-a', 'nas-b'] });
    const session = await connectSession(['--config', configPath, '--fail-pool-query', 'nas-b']);
    try {
      const result = (await session.client.callTool({
        name: 'storage_pool_status',
        arguments: { systems: 'all' },
      })) as CallToolResult;
      // One system down is data, not a failed call — raising it as a call
      // failure would throw away the healthy system's answer.
      expect(result.isError).toBeUndefined();
      // errname/errno below are fabricated by the fixture: the real
      // api-client currently flattens API failures to a plain message before
      // they reach the core (both arrive null in production). This asserts
      // the transport preserves them when present — not that production
      // populates them.
      expect(parseResults(result)).toEqual([
        {
          system: 'nas-a',
          status: 'SUCCESS',
          value: [
            {
              name: 'tank',
              status: 'ONLINE',
              healthy: true,
              size_bytes: 100,
              allocated_bytes: 40,
              free_bytes: 60,
              // The fixture answers no feature-flag read, and the core reports
              // "not established" as null rather than as false.
              feature_flags_current: null,
            },
          ],
        },
        {
          system: 'nas-b',
          status: 'ERROR',
          error: {
            message: 'fixture: pool.query configured to fail on nas-b',
            errname: 'EFAULT',
            errno: 14,
          },
        },
      ]);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('approval path: the plan names every system, and the confirmed execution returns one result per system', async () => {
    const { configPath, auditPath } = writeConfig({
      systems: ['nas-a', 'nas-b'],
      requireElicitation: false,
    });
    const session = await connectSession(['--config', configPath]);
    try {
      const planned = (await session.client.callTool({
        name: 'snapshots_create',
        arguments: { dataset: 'tank/data', name: 'before', systems: 'all' },
      })) as CallToolResult;
      expect(planned.isError).toBeUndefined();
      const planText = (planned.content[0] as { text: string }).text;

      // The serialization half of what tier 3 asserts on a screen: the plan
      // that crossed real stdio names both systems, one step each.
      expect(planText).toContain('Target systems: nas-a, nas-b');
      expect(planText).toContain('- [nas-a] Create snapshot "tank/data@before"');
      expect(planText).toContain('- [nas-b] Create snapshot "tank/data@before"');

      const token = /Confirmation token \(single-use, expires\): (\S+)/.exec(planText)?.[1];
      expect(token, planText).toBeDefined();
      const confirmed = (await session.client.callTool({
        name: 'snapshots_create',
        arguments: {
          dataset: 'tank/data',
          name: 'before',
          systems: 'all',
          confirmation_token: token,
        },
      })) as CallToolResult;
      expect(confirmed.isError).toBeUndefined();
      // A mutating fan-out EXECUTION crossing real stdio, one result per
      // system — the only test that reaches the fixture's
      // pool.snapshot.create handler.
      expect(parseResults(confirmed)).toEqual([
        { system: 'nas-a', status: 'SUCCESS', value: { created: 'tank/data@before' } },
        { system: 'nas-b', status: 'SUCCESS', value: { created: 'tank/data@before' } },
      ]);

      // The audit sink writes per event, so no shutdown is needed here.
      await until(() => readFileSync(auditPath, 'utf8').includes('"execute"'));
      const events = readFileSync(auditPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; phase: string });
      expect(events.some((e) => e.tool === 'snapshots_create' && e.phase === 'execute')).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe('stdout purity (raw pipes)', () => {
  it('stdout carries nothing but JSON-RPC frames for the whole session', async () => {
    const { configPath } = writeConfig();
    const child = spawn(process.execPath, [fixture, '--config', configPath], {
      env: childEnv(),
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    const stderr = collect(child.stderr);
    const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
    const stdout = (): string => Buffer.concat(out).toString();

    // Hand-rolled frames: this test must see the raw byte stream, which the
    // SDK transport would consume.
    const frame = (message: Record<string, unknown>): string => `${JSON.stringify(message)}\n`;
    await until(() => stderr.text().includes('serving nas-a'));
    child.stdin.write(
      frame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'raw', version: '0' },
        },
      }),
    );
    child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await until(() => stdout().includes('"id":2'));

    child.kill('SIGTERM');
    await exited;
    clearTimeout(killer);

    // THE tier-2 assertion: every stdout byte belongs to a JSON-RPC frame.
    // A single stray console.log would break every MCP client at once.
    const lines = stdout().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    const last = lines.pop();
    expect(last).toBe(''); // stream ends with a newline-terminated frame
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc, line).toBe('2.0');
    }
    // Both responses actually arrived through the pipe we audited.
    expect(stdout()).toContain('"id":1');
    expect(stdout()).toContain('"id":2');
  }, 30_000);
});
