import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The CLI is the product; these tests run it for real (via tsx, so dist/ can
 * never be stale) and assert the dispatch surface: routing, error reporting,
 * and exit codes. Anything needing a live NAS stays out of scope.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const tsxBin = join(root, 'node_modules', '.bin', 'tsx');
const cliPath = join(root, 'src', 'cli.ts');

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], stdin = ''): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    // Ambient config/trace env vars must not leak into the assertions.
    const env = { ...process.env };
    delete env['TRUENAS_MCP_CONFIG'];
    delete env['TRUENAS_MCP_TRACE'];
    const child = spawn(tsxBin, [cliPath, ...args], { env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      }),
    );
    child.stdin.end(stdin);
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnmcp-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli', () => {
  it('prints usage on --help', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('truenas-mcp-server init');
  }, 30_000);

  it('prints the version on --version', async () => {
    const { code, stdout } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 30_000);

  it('rejects unknown commands with the usage text', async () => {
    const { code, stderr } = await cli(['frobnicate']);
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command "frobnicate"');
    expect(stderr).toContain('Usage:');
  }, 30_000);

  it('serve fails cleanly when the config file is missing', async () => {
    const { code, stderr } = await cli(['--config', join(dir, 'nope.json')]);
    expect(code).toBe(1);
    expect(stderr).toContain('Config file not found');
    // Expected failures print the curated message only — no stack trace.
    expect(stderr).not.toMatch(/^\s+at /m);
  }, 30_000);

  it('rejects unknown options without a stack trace', async () => {
    const { code, stderr } = await cli(['--bogus']);
    expect(code).toBe(1);
    expect(stderr).toContain("'--bogus'");
    expect(stderr).not.toMatch(/^\s+at /m);
  }, 30_000);

  it('routes init and exits non-zero when stdin ends early', async () => {
    const { code, stdout } = await cli(['init', '--config', join(dir, 'config.json')]);
    expect(code).toBe(1);
    expect(stdout).toContain('Input ended before setup finished — aborting.');
  }, 30_000);

  it('serve fails at startup on an unusable --trace path, before connecting', async () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        systems: [{ name: 'x', host: '192.0.2.1', username: 'u', apiKey: 'k' }],
      }),
      { mode: 0o600 },
    );
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, '');
    const { code, stderr } = await cli([
      '--config',
      configPath,
      '--trace',
      join(blocker, 'trace.jsonl'),
    ]);
    expect(code).toBe(1);
    // The errno differs by platform (EEXIST on macOS, ENOTDIR on Linux).
    expect(stderr).toMatch(/ENOTDIR|EEXIST|not a directory/);
  }, 30_000);
});
