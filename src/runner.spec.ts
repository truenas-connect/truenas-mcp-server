import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrueNasApiClient } from '@truenas/api-client';
import { type ClientFactory } from '@truenas/mcp-base';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config';
import { runServer, type RunningServer } from '@/runner';

/**
 * These drive the real connect-and-serve wiring in-process, over a linked
 * in-memory transport. The subprocess/stdio half — stdout purity, the shebang,
 * SIGTERM — belongs to tier 2 (Phases 3 and 4); what is proved here is that
 * the wiring itself is correct, which is the thing a Phase 4 fixture would
 * otherwise have had to reimplement to test at all.
 */

function fakeClient(): TrueNasApiClient {
  return {
    api: { call: vi.fn(() => of([{ id: 'tank/x', name: 'tank/x' }])) },
    close: vi.fn(),
  } as unknown as TrueNasApiClient;
}

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    systems: [
      { name: 'nas-a', hostnames: ['a.local'], username: 'admin', apiKey: 'k1' },
      { name: 'nas-b', hostnames: ['b.local'], username: 'admin', apiKey: 'k2' },
    ],
    ...overrides,
  };
}

let dir: string;
let running: RunningServer | undefined;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnmcp-runner-'));
  // The banner and warnings are deliberate stderr writes; keep them out of the
  // test output while still asserting on them.
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  running?.dispose();
  running = undefined;
  stderr.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

/** Starts the server on one end of a linked pair and returns a connected client. */
async function start(
  cfg: ServerConfig,
  options: { tracePath?: string; clientFactory?: ClientFactory } = {},
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, {});
  const started = runServer(cfg, {
    configPath: join(dir, 'config.json'),
    transport: serverTransport,
    exit: () => undefined,
    clientFactory: options.clientFactory ?? (() => Promise.resolve(fakeClient())),
    ...(options.tracePath === undefined ? {} : { tracePath: options.tracePath }),
  });
  const [handle] = await Promise.all([started, client.connect(clientTransport)]);
  running = handle;
  return client;
}

function text(result: unknown): string {
  return ((result as CallToolResult).content[0] as { text: string }).text;
}

describe('runServer', () => {
  it('connects every configured system and serves the catalog over the transport', async () => {
    const client = await start(config());
    expect(running?.systems).toEqual(['nas-a', 'nas-b']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('snapshots_create');
  });

  it('uses the injected client factory once per configured system', async () => {
    const factory = vi.fn<ClientFactory>(() => Promise.resolve(fakeClient()));
    await start(config(), { clientFactory: factory });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls.map(([spec]) => spec.name)).toEqual(['nas-a', 'nas-b']);
  });

  it('closes the clients that did connect when another system fails', async () => {
    const connected = fakeClient();
    const factory: ClientFactory = (spec) =>
      spec.name === 'nas-b'
        ? Promise.reject(new Error('auth failed'))
        : Promise.resolve(connected);
    await expect(
      runServer(config(), {
        configPath: join(dir, 'config.json'),
        transport: InMemoryTransport.createLinkedPair()[1],
        exit: () => undefined,
        clientFactory: factory,
      }),
    ).rejects.toThrow(/nas-b: auth failed/);
    expect(connected.close).toHaveBeenCalled();
  });

  it('refuses mutating calls by default — requireElicitation is not opted out of', async () => {
    const client = await start(config());
    const result = await client.callTool({
      name: 'snapshots_create',
      arguments: { dataset: 'tank/x', name: 'before', systems: 'all' },
    });
    expect((result as CallToolResult).isError).toBe(true);
    expect(text(result)).toContain('does not support elicitation');
    expect(text(result)).not.toContain('Confirmation token');
  });

  it('threads requireElicitation: false from the config into the server', async () => {
    const client = await start(config({ requireElicitation: false }));
    const result = await client.callTool({
      name: 'snapshots_create',
      arguments: { dataset: 'tank/x', name: 'before', systems: 'all' },
    });
    expect((result as CallToolResult).isError).toBeUndefined();
    expect(text(result)).toContain('Confirmation token');
  });

  it('prepares the trace file before serving, so an unusable path fails at startup', async () => {
    const factory = vi.fn<ClientFactory>(() => Promise.resolve(fakeClient()));
    // A path *under a regular file* cannot be created (ENOTDIR). Writing the
    // file first matters: without it mkdir would happily create a directory
    // of that name and the path would be perfectly usable.
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    const bad = join(blocker, 'trace.jsonl');
    await expect(
      runServer(config(), {
        configPath: join(dir, 'config.json'),
        tracePath: bad,
        transport: InMemoryTransport.createLinkedPair()[1],
        exit: () => undefined,
        clientFactory: factory,
      }),
    ).rejects.toThrow();
    // Nothing connected: the trace check runs before connectSystems.
    expect(factory).not.toHaveBeenCalled();
  });

  it('captures frames in both directions once tracing is enabled', async () => {
    const tracePath = join(dir, 'trace.jsonl');
    const client = await start(config(), { tracePath });
    await client.listTools();
    const frames = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { dir: string; message: { method?: string } });
    expect(frames.some((f) => f.dir === 'recv' && f.message.method === 'tools/list')).toBe(true);
    expect(frames.some((f) => f.dir === 'send')).toBe(true);
    // Deliberately not asserted here: that the `initialize` handshake is also
    // captured. Over real stdio it is — connect resolves before the event loop
    // reads the first stdin bytes — but a linked in-memory pair delivers it
    // synchronously enough to race the tracing wrap. The no-await-after-connect
    // invariant is what makes the stdio case work; assert the handshake in the
    // Phase 4 subprocess fixture, where the transport is the real one.
  });

  it('announces the served systems and config path on stderr', async () => {
    await start(config());
    const banner = stderr.mock.calls.map((args) => String(args[0])).join('\n');
    expect(banner).toContain('serving nas-a, nas-b');
    expect(banner).toContain('config.json');
  });

  it('warns on stderr when allowSelfSigned is enabled', async () => {
    await start(config({ allowSelfSigned: true }));
    const warnings = stderr.mock.calls.map((args) => String(args[0])).join('\n');
    expect(warnings).toContain('allowSelfSigned');
    expect(warnings).toContain('certificate verification is disabled');
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  it('dispose removes the signal handlers it installed', async () => {
    const before = process.listenerCount('SIGTERM');
    await start(config());
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    running?.dispose();
    running = undefined;
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('closes the connected clients when serving itself fails after connect', async () => {
    const connected = fakeClient();
    // A transport whose start() rejects fails inside serve(), after
    // connectSystems has already handed back live clients — the one path that
    // leaks sockets if the rollback is ever dropped.
    const brokenTransport = {
      start: () => Promise.reject(new Error('transport refused to start')),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    } as unknown as Transport;
    await expect(
      runServer(config(), {
        configPath: join(dir, 'config.json'),
        transport: brokenTransport,
        exit: () => undefined,
        clientFactory: () => Promise.resolve(connected),
      }),
    ).rejects.toThrow(/transport refused to start/);
    expect(connected.close).toHaveBeenCalled();
  });

  it('reports audit-sink failures on stderr without altering the tool result', async () => {
    // An audit path under a regular file can never be written.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const client = await start(config({ auditLog: join(blocker, 'audit.jsonl') }));
    const result = await client.callTool({
      name: 'system_info',
      arguments: { systems: 'all' },
    });
    // The call still succeeds — a broken trail must not break the tool.
    expect((result as CallToolResult).isError).toBeUndefined();
    await vi.waitFor(() => {
      const logged = stderr.mock.calls.map((args) => String(args[0])).join('\n');
      expect(logged).toContain('Audit sink failed for system_info/read:');
    });
  });

  it('drains and closes on transport close, then exits zero', async () => {
    const connected = fakeClient();
    const exit = vi.fn();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' }, {});
    const started = runServer(config(), {
      configPath: join(dir, 'config.json'),
      transport: serverTransport,
      exit,
      clientFactory: () => Promise.resolve(connected),
    });
    [running] = await Promise.all([started, client.connect(clientTransport)]);

    // The host quitting closes the transport; server.onclose is the shutdown.
    await client.close();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(connected.close).toHaveBeenCalled();
  });

  it('a throwing close during rollback does not mask the startup failure', async () => {
    const connected = {
      api: { call: vi.fn() },
      close: vi.fn(() => {
        throw new Error('socket already gone');
      }),
    } as unknown as TrueNasApiClient;
    const brokenTransport = {
      start: () => Promise.reject(new Error('transport refused to start')),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    } as unknown as Transport;
    // The rollback's own failure is swallowed: the error worth reporting is
    // the one that stopped startup, not the one from cleaning up after it.
    await expect(
      runServer(config(), {
        configPath: join(dir, 'config.json'),
        transport: brokenTransport,
        exit: () => undefined,
        clientFactory: () => Promise.resolve(connected),
      }),
    ).rejects.toThrow(/transport refused to start/);
    expect(connected.close).toHaveBeenCalled();
  });
});
