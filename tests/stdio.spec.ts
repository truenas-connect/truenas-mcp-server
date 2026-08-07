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
 * Tier 2b (testing-plan Phase 4): a real MCP session, over real stdio pipes,
 * against the built artifact. The fixture runs the exported runServer from
 * dist/ with only the ClientFactory substituted (the Phase 2 seam), so the
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

function writeConfig(): { configPath: string; auditPath: string } {
  const configPath = join(dir, 'config.json');
  const auditPath = join(dir, 'audit.jsonl');
  writeFileSync(
    configPath,
    JSON.stringify({
      systems: [{ name: 'nas-a', host: '192.0.2.1', username: 'u', apiKey: 'k' }],
      auditLog: auditPath,
    }),
    { mode: 0o600 },
  );
  return { configPath, auditPath };
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
      const body = (result as CallToolResult).content[0] as { type: 'text'; text: string };
      const parsed = JSON.parse(body.text.slice(body.text.indexOf('['))) as {
        system: string;
        status: string;
        value: { name: string; healthy: boolean }[];
      }[];
      expect(parsed).toEqual([
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
