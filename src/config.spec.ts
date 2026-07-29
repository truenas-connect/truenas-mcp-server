import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTlsPolicy,
  defaultConfigPath,
  loadConfig,
  parseConfig,
  resolveConfigPath,
} from '@/config';

const system = { name: 'a', host: 'a.local', username: 'admin', apiKey: 'k' };

describe('parseConfig', () => {
  it('accepts the single-host form', () => {
    const config = parseConfig(JSON.stringify({ systems: [system] }));
    expect(config.systems).toEqual([
      { name: 'a', hostnames: ['a.local'], username: 'admin', apiKey: 'k' },
    ]);
    expect(config.auditLog).toBeUndefined();
  });

  it('accepts the hostnames form and optional uuid', () => {
    const config = parseConfig(
      JSON.stringify({
        systems: [
          { name: 'a', hostnames: ['a.local', 'a.fallback'], username: 'admin', apiKey: 'k', uuid: 'u1' },
        ],
      }),
    );
    expect(config.systems[0].hostnames).toEqual(['a.local', 'a.fallback']);
    expect(config.systems[0].uuid).toBe('u1');
  });

  it('accepts allowSelfSigned', () => {
    const config = parseConfig(JSON.stringify({ systems: [system], allowSelfSigned: true }));
    expect(config.allowSelfSigned).toBe(true);
  });

  it('accepts requireElicitation and rejects non-boolean values', () => {
    const config = parseConfig(JSON.stringify({ systems: [system], requireElicitation: true }));
    expect(config.requireElicitation).toBe(true);
    expect(() =>
      parseConfig(JSON.stringify({ systems: [system], requireElicitation: 'yes' })),
    ).toThrow(/requireElicitation must be a boolean/);
  });

  it('expands ~ in auditLog', () => {
    const config = parseConfig(JSON.stringify({ systems: [system], auditLog: '~/audit.jsonl' }));
    expect(config.auditLog).toBe(join(homedir(), 'audit.jsonl'));
  });

  it.each([
    ['not JSON at all', 'nope{', /not valid JSON/],
    ['a non-object root', '[]', /must be a JSON object/],
    ['a missing systems list', '{}', /"systems" must be a non-empty array/],
    ['an empty systems list', '{"systems":[]}', /"systems" must be a non-empty array/],
    [
      'both host and hostnames',
      JSON.stringify({ systems: [{ ...system, hostnames: ['x'] }] }),
      /exactly one of "host"/,
    ],
    [
      'neither host nor hostnames',
      JSON.stringify({ systems: [{ name: 'a', username: 'admin', apiKey: 'k' }] }),
      /exactly one of "host"/,
    ],
    [
      'a missing apiKey',
      JSON.stringify({ systems: [{ name: 'a', host: 'h', username: 'admin' }] }),
      /apiKey must be a non-empty string/,
    ],
    [
      'unknown system keys (typo protection)',
      JSON.stringify({ systems: [{ ...system, apikey: 'oops' }] }),
      /unknown key\(s\): apikey/,
    ],
    [
      'unknown root keys',
      JSON.stringify({ systems: [system], audit_log: 'x' }),
      /unknown key\(s\): audit_log/,
    ],
    [
      'a non-boolean allowSelfSigned',
      JSON.stringify({ systems: [system], allowSelfSigned: 'yes' }),
      /allowSelfSigned must be a boolean/,
    ],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseConfig(text)).toThrow(message);
  });

  it('prefixes errors with the source label', () => {
    expect(() => parseConfig('{}', '/etc/tn.json')).toThrow(/^\/etc\/tn\.json/);
  });
});

describe('resolveConfigPath', () => {
  it('prefers the flag over the environment over the default', () => {
    const env = { TRUENAS_MCP_CONFIG: '/from-env.json' };
    expect(resolveConfigPath('/from-flag.json', env)).toBe('/from-flag.json');
    expect(resolveConfigPath(undefined, env)).toBe('/from-env.json');
    expect(resolveConfigPath(undefined, {})).toBe(defaultConfigPath());
  });

  it('expands ~ in the resolved path', () => {
    expect(resolveConfigPath('~/tn.json', {})).toBe(join(homedir(), 'tn.json'));
  });
});

describe('applyTlsPolicy', () => {
  it('sets NODE_TLS_REJECT_UNAUTHORIZED=0 and restores the previous value', () => {
    const before = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    const restore = applyTlsPolicy({ systems: [], allowSelfSigned: true });
    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('0');
    restore();
    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe(before);
  });

  it('does nothing when allowSelfSigned is not enabled', () => {
    const before = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    applyTlsPolicy({ systems: [] })();
    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe(before);
  });
});

describe('loadConfig', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and parses a config file', () => {
    dir = mkdtempSync(join(tmpdir(), 'tnmcp-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ systems: [system] }), { mode: 0o600 });
    expect(loadConfig(path).systems).toHaveLength(1);
  });

  it('explains a missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'tnmcp-'));
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/Config file not found at .*nope\.json/);
  });

  it('warns when the file is readable by other users, and only then', () => {
    dir = mkdtempSync(join(tmpdir(), 'tnmcp-'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const broad = join(dir, 'broad.json');
      writeFileSync(broad, JSON.stringify({ systems: [system] }), { mode: 0o644 });
      loadConfig(broad);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining(`chmod 600 ${broad}`));

      spy.mockClear();
      const tight = join(dir, 'tight.json');
      writeFileSync(tight, JSON.stringify({ systems: [system] }), { mode: 0o600 });
      loadConfig(tight);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
