import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Tier 2a (testing-plan Phase 3): the shipped artifact, not the sources.
 * Everything here spawns `dist/cli.js` directly or inspects the packaged
 * output — catching shebang loss, `bin` mapping errors, `files: ["dist"]`
 * gaps and tsup config regressions, none of which tsx-on-source can see.
 * The dispatch surface itself (routing, error curation, exit codes) is
 * cli.spec.ts's job; the cases here overlap it only enough to prove the
 * artifact starts and reports correctly.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const distCli = join(root, 'dist', 'cli.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
  files: string[];
  main: string;
  module: string;
  types: string;
  exports: Record<
    string,
    string | Record<'import' | 'require', string | Record<'types' | 'default', string>>
  >;
};

beforeAll(() => {
  if (!existsSync(distCli)) {
    throw new Error('dist/cli.js not found — run "yarn build" before "yarn test:dist"');
  }
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    // Ambient config/trace/debug env vars must not leak into the assertions.
    const env = { ...process.env };
    delete env['TRUENAS_MCP_CONFIG'];
    delete env['TRUENAS_MCP_TRACE'];
    delete env['TRUENAS_MCP_DEBUG'];
    const child = spawn(process.execPath, [distCli, ...args], { env });
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
    child.stdin.end('');
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnmcp-dist-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('dist/cli.js', () => {
  it('prints the version on --version', async () => {
    const { code, stdout } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 30_000);

  it('prints usage on --help', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('truenas-mcp-server init');
  }, 30_000);

  it('serve fails cleanly when the config file is missing', async () => {
    const { code, stderr } = await cli(['--config', join(dir, 'nope.json')]);
    expect(code).toBe(1);
    expect(stderr).toContain('Config file not found');
    // Expected failures print the curated message only — no stack trace.
    expect(stderr).not.toMatch(/^\s+at /m);
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

describe('packaged artifact shape', () => {
  it('keeps the shebang as the first line of dist/cli.js', () => {
    const firstLine = readFileSync(distCli, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('maps the bin name to a file that exists inside the shipped "files"', () => {
    const binPath = pkg.bin['truenas-mcp-server'];
    expect(binPath).toBe('./dist/cli.js');
    expect(pkg.files).toContain('dist');
    expect(existsSync(join(root, binPath))).toBe(true);
  });

  it('ships every file that main/module/types and the exports map reference', () => {
    // The exports map is the part a source test genuinely cannot cover: a
    // tsup dts regression dropping e.g. index.d.cts breaks CJS consumers'
    // types while everything else stays green.
    const referenced = [pkg.main, pkg.module, pkg.types];
    // The exports spec also allows string shorthand at either level; collect
    // every leaf so a shape change fails with the missing path in the
    // message, not with existsSync(undefined).
    for (const entry of Object.values(pkg.exports)) {
      if (typeof entry === 'string') {
        referenced.push(entry);
        continue;
      }
      for (const format of Object.values(entry)) {
        if (typeof format === 'string') {
          referenced.push(format);
        } else {
          referenced.push(format.types, format.default);
        }
      }
    }
    for (const relative of referenced) {
      expect(relative, 'exports map leaf').toBeTypeOf('string');
      expect(existsSync(join(root, relative)), relative).toBe(true);
    }
  });

  it('exposes runServer and createServer from the ESM entry', async () => {
    const mod = (await import(pathToFileURL(join(root, 'dist', 'index.js')).href)) as Record<
      string,
      unknown
    >;
    expect(typeof mod['runServer']).toBe('function');
    expect(typeof mod['createServer']).toBe('function');
  }, 30_000);

  it('exposes runServer from the CJS entry', () => {
    const require = createRequire(import.meta.url);
    const mod = require(join(root, 'dist', 'index.cjs')) as Record<string, unknown>;
    expect(typeof mod['runServer']).toBe('function');
  });
});
