import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { TrueNasApiClient } from '@truenas/api-client';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config';
import { runServer } from '@/run';
import type { ServerDeps } from '@/server';

/**
 * runServer is process wiring and is exercised for real by subprocess tests
 * (cli.spec.ts, and the tier-2 fixtures). The one thing those cannot see
 * cheaply is the wire between config and createServer — in particular that
 * `requireElicitation` crosses it, since config.spec.ts covers parsing and
 * server.spec.ts covers behavior but neither covers the hand-off. createServer
 * is mocked here so nothing touches real stdio.
 */

const { captured } = vi.hoisted(() => ({ captured: [] as ServerDeps[] }));

vi.mock('@/server', () => ({
  createServer: (deps: ServerDeps): Server => {
    captured.push(deps);
    // runServer only assigns onclose and awaits connect; nothing must touch
    // the real stdio transport it is handed.
    return { connect: vi.fn().mockResolvedValue(undefined), onclose: undefined } as unknown as Server;
  },
}));

function config(requireElicitation?: boolean): ServerConfig {
  return {
    systems: [{ name: 'a', hostnames: ['192.0.2.1'], username: 'u', apiKey: 'k' }],
    ...(requireElicitation !== undefined ? { requireElicitation } : {}),
  };
}

/** Runs runServer with a fake factory, restoring the signal handlers it adds. */
async function run(cfg: ServerConfig): Promise<ServerDeps> {
  const before = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await runServer(cfg, {
      configPath: '/dev/null/config.json',
      clientFactory: () => Promise.resolve({ close: vi.fn() } as unknown as TrueNasApiClient),
    });
  } finally {
    errorSpy.mockRestore();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
  }
  const deps = captured.pop();
  expect(deps).toBeDefined();
  return deps as ServerDeps;
}

describe('runServer — config to createServer wire', () => {
  it('passes requireElicitation: true through', async () => {
    const deps = await run(config(true));
    expect(deps.requireElicitation).toBe(true);
  });

  it('passes the explicit false opt-in through', async () => {
    const deps = await run(config(false));
    expect(deps.requireElicitation).toBe(false);
  });

  it('omits the key entirely when the config leaves it unset, so the default-deny applies', async () => {
    const deps = await run(config());
    // Absent, not `undefined`: createServer must see no key at all so its own
    // default (refuse) governs.
    expect('requireElicitation' in deps).toBe(false);
  });
});
