import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TrueNasApiClient } from '@truenas/api-client';
import type { ClientFactory } from '@truenas/mcp-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '@/init';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnmcp-init-'));
  path = join(dir, 'nested', 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(
  answers: string[],
  options: { force?: boolean; clientFactory?: ClientFactory; verifyTimeoutMs?: number } = {},
): Promise<{ ok: boolean; transcript: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  input.end(answers.map((answer) => `${answer}\n`).join(''));
  const ok = await runInit({ path, input, output, ...options });
  return { ok, transcript: Buffer.concat(chunks).toString() };
}

function written(): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Enough TTY surface for readline to enter terminal mode (echo + keypress). */
class FakeTty extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
}

describe('runInit', () => {
  it('creates a single-system config using the defaults', async () => {
    // name (default), host, username (default), apiKey, no more systems,
    // no audit log, skip verification.
    const { ok, transcript } = await run(['', 'nas.local', '', 'secret-key', 'n', '', '', 'n']);
    expect(ok).toBe(true);
    expect(transcript).toContain(`Wrote ${path}`);
    expect(written()).toEqual({
      systems: [
        { name: 'truenas', host: 'nas.local', username: 'truenas_admin', apiKey: 'secret-key' },
      ],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('turns comma-separated hosts into a hostnames list and keeps the audit log', async () => {
    const { ok } = await run(['nas1', 'a.local, 10.0.0.5', 'root', 'k', 'n', '', '/tmp/audit.jsonl', 'n']);
    expect(ok).toBe(true);
    expect(written()).toEqual({
      systems: [{ name: 'nas1', hostnames: ['a.local', '10.0.0.5'], username: 'root', apiKey: 'k' }],
      auditLog: '/tmp/audit.jsonl',
    });
  });

  it('re-prompts when the host answer contains no hosts', async () => {
    const { ok, transcript } = await run(['nas1', ', ,', 'a.local', '', 'k', 'n', '', '', 'n']);
    expect(ok).toBe(true);
    expect(transcript).toContain('At least one host is required');
    expect(written()).toMatchObject({ systems: [{ name: 'nas1', host: 'a.local' }] });
  });

  it('collects multiple systems and re-prompts on reserved or duplicate names', async () => {
    const { ok, transcript } = await run([
      // First system: "all" is rejected, then accepted as nas1.
      'all', 'nas1', 'a.local', '', 'k1',
      // Second system: duplicate rejected, then nas2.
      'y', 'nas1', 'nas2', 'b.local', '', 'k2',
      'n', '', '', 'n',
    ]);
    expect(ok).toBe(true);
    expect(transcript).toContain('"all" is a reserved system name');
    expect(transcript).toContain('"nas1" is already used');
    expect((written() as { systems: { name: string }[] }).systems.map((s) => s.name)).toEqual([
      'nas1',
      'nas2',
    ]);
  });

  it('leaves an existing config untouched when overwrite is declined', async () => {
    path = join(dir, 'config.json');
    writeFileSync(path, '{"existing":true}');
    const { ok, transcript } = await run(['n']);
    expect(ok).toBe(false);
    expect(transcript).toContain('Aborted');
    expect(readFileSync(path, 'utf8')).toBe('{"existing":true}');
  });

  it('overwrites without asking when force is set', async () => {
    path = join(dir, 'config.json');
    writeFileSync(path, '{"existing":true}');
    const { ok } = await run(['', 'nas.local', '', 'k', 'n', '', '', 'n'], { force: true });
    expect(ok).toBe(true);
    expect(written()).toHaveProperty('systems');
  });

  it('verifies connectivity through the injected client factory', async () => {
    const close = vi.fn();
    const factory: ClientFactory = () =>
      Promise.resolve({ close } as unknown as TrueNasApiClient);
    // Empty last answer takes the verification default (yes).
    const { ok, transcript } = await run(['', 'nas.local', '', 'k', 'n', '', '', ''], {
      clientFactory: factory,
    });
    expect(ok).toBe(true);
    expect(transcript).toContain('✓ Connected and authenticated: truenas');
    expect(close).toHaveBeenCalled();
  });

  it('keeps the written config and reports failure when verification fails', async () => {
    const factory: ClientFactory = () => Promise.reject(new Error('self-signed certificate'));
    const { ok, transcript } = await run(['', 'nas.local', '', 'k', 'n', '', '', 'y'], {
      clientFactory: factory,
    });
    expect(ok).toBe(false);
    expect(transcript).toContain('✗ Failed to connect: truenas: self-signed certificate');
    expect(transcript).toContain('allow self-signed certificates');
    expect(transcript).toContain('written anyway');
    expect(written()).toHaveProperty('systems');
  });

  it('records allowSelfSigned and applies it during verification, then restores', async () => {
    const before = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    let during: string | undefined;
    const factory: ClientFactory = () => {
      during = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      return Promise.resolve({ close: vi.fn() } as unknown as TrueNasApiClient);
    };
    const { ok } = await run(['', 'nas.local', '', 'k', 'n', 'y', '', ''], {
      clientFactory: factory,
    });
    expect(ok).toBe(true);
    expect(written()).toMatchObject({ allowSelfSigned: true });
    expect(during).toBe('0');
    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe(before);
  });

  it('closes clients created before a verification timeout', async () => {
    const close = vi.fn();
    const factory: ClientFactory = (spec) =>
      spec.name === 'a1'
        ? Promise.resolve({ close } as unknown as TrueNasApiClient)
        : new Promise<TrueNasApiClient>(() => undefined);
    const { ok, transcript } = await run(
      ['a1', 'h1', '', 'k1', 'y', 'a2', 'h2', '', 'k2', 'n', '', '', ''],
      { clientFactory: factory, verifyTimeoutMs: 50 },
    );
    expect(ok).toBe(false);
    expect(transcript).toContain('Timed out');
    // a1's client resolved before the timeout but was never registered —
    // it must still be closed, or its sockets would keep the process alive.
    expect(close).toHaveBeenCalled();
  });

  it('masks the API-key echo with asterisks on a TTY', async () => {
    const input = new FakeTty();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const transcript = (): string => Buffer.concat(chunks).toString();

    const done = runInit({ path, input, output });
    // Answers are driven prompt-by-prompt, like real typing: masking is
    // per-question state, so type-ahead would echo under the previous prompt.
    const answer = async (prompt: string, reply: string): Promise<void> => {
      await vi.waitFor(() => {
        if (!transcript().includes(prompt)) {
          throw new Error(`still waiting for prompt "${prompt}"`);
        }
      });
      input.write(reply);
    };
    await answer('Name (how the LLM', '\n');
    await answer('Host (comma-separate', 'nas.local\n');
    await answer('Username the API key', '\n');
    await answer('API key (input masked)', 'SECRETKEY\n');
    await answer('Add another system?', 'n\n');
    await answer('Allow self-signed certificates?', '\n');
    await answer('audit log path', '\n');
    await answer('Verify connectivity', 'n\n');
    expect(await done).toBe(true);

    // Terminal mode echoes normal answers…
    expect(transcript()).toContain('nas.local');
    // …but the key is redrawn as one '*' per typed character, never in clear.
    expect(transcript()).toContain('*'.repeat('SECRETKEY'.length));
    expect(transcript()).not.toContain('SECRETKEY');
  });

  it('aborts gracefully when input ends before setup finishes', async () => {
    const { ok, transcript } = await run([]);
    expect(ok).toBe(false);
    expect(transcript).toContain('Input ended before setup finished — aborting.');
  });

  it('times out instead of hanging when a system never responds', async () => {
    const factory: ClientFactory = () => new Promise<TrueNasApiClient>(() => undefined);
    const { ok, transcript } = await run(['', 'nas.local', '', 'k', 'n', '', '', 'y'], {
      clientFactory: factory,
      verifyTimeoutMs: 50,
    });
    expect(ok).toBe(false);
    expect(transcript).toContain('Timed out after 0.05s');
    expect(transcript).toContain('written anyway');
  });
});
