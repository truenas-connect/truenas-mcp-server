/**
 * Local config file — the standalone server's CredentialProvider (ER-172 C1.2,
 * C1.7, S3.1): one JSON file the user writes once, no cloud account.
 *
 *   {
 *     "systems": [
 *       { "name": "nas-a", "host": "nas-a.local", "username": "admin", "apiKey": "..." }
 *     ],
 *     "auditLog": "~/.local/state/truenas-mcp/audit.jsonl"
 *   }
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CredentialProvider, SystemSpec } from '@truenas/mcp-base';

export interface ServerConfig {
  systems: SystemSpec[];
  /** Optional JSONL audit log path. When unset, audit events go to stderr. */
  auditLog?: string;
  /**
   * Refuse mutating tool calls from MCP clients that do not support
   * elicitation, instead of falling back to the in-chat plan+token flow —
   * that fallback's only human gate is the host's own tool-call prompt.
   */
  requireElicitation?: boolean;
  /**
   * Accept self-signed TLS certificates (TrueNAS ships one by default).
   * Node's native fetch/WebSocket have no per-connection TLS hook, so this is
   * necessarily process-wide (NODE_TLS_REJECT_UNAUTHORIZED=0) — it disables
   * certificate verification for every configured system.
   */
  allowSelfSigned?: boolean;
}

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'truenas-mcp', 'config.json');
}

export function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** `--config` flag, then `TRUENAS_MCP_CONFIG`, then `~/.config/truenas-mcp/config.json`. */
export function resolveConfigPath(
  flag?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return expandTilde(flag ?? env['TRUENAS_MCP_CONFIG'] ?? defaultConfigPath());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Unknown keys are rejected rather than ignored: a typo like "apikey" would
 * otherwise silently produce a missing-credential error somewhere else.
 */
function rejectUnknownKeys(value: Record<string, unknown>, known: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} has unknown key(s): ${unknown.join(', ')} — expected only ${known.join(', ')}`,
    );
  }
}

function parseSystem(value: unknown, label: string): SystemSpec {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownKeys(value, ['name', 'host', 'hostnames', 'username', 'apiKey', 'uuid'], label);
  const name = requireString(value['name'], `${label}.name`);
  const host = value['host'];
  const hostnames = value['hostnames'];
  if ((host === undefined) === (hostnames === undefined)) {
    throw new Error(`${label} must have exactly one of "host" (string) or "hostnames" (array)`);
  }
  let resolvedHostnames: string[];
  if (host !== undefined) {
    resolvedHostnames = [requireString(host, `${label}.host`)];
  } else {
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      throw new Error(`${label}.hostnames must be a non-empty array of strings`);
    }
    resolvedHostnames = hostnames.map((entry, i) =>
      requireString(entry, `${label}.hostnames[${i}]`),
    );
  }
  const spec: SystemSpec = {
    name,
    hostnames: resolvedHostnames,
    username: requireString(value['username'], `${label}.username`),
    apiKey: requireString(value['apiKey'], `${label}.apiKey`),
  };
  if (value['uuid'] !== undefined) {
    spec.uuid = requireString(value['uuid'], `${label}.uuid`);
  }
  return spec;
}

export function parseConfig(text: string, source = 'config'): ServerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new Error(`${source} must be a JSON object`);
  }
  rejectUnknownKeys(raw, ['systems', 'auditLog', 'allowSelfSigned', 'requireElicitation'], source);
  const systems = raw['systems'];
  if (!Array.isArray(systems) || systems.length === 0) {
    throw new Error(`${source}: "systems" must be a non-empty array`);
  }
  const config: ServerConfig = {
    systems: systems.map((entry, i) => parseSystem(entry, `${source}: systems[${i}]`)),
  };
  if (raw['auditLog'] !== undefined) {
    config.auditLog = expandTilde(requireString(raw['auditLog'], `${source}: auditLog`));
  }
  if (raw['requireElicitation'] !== undefined) {
    if (typeof raw['requireElicitation'] !== 'boolean') {
      throw new Error(`${source}: requireElicitation must be a boolean`);
    }
    config.requireElicitation = raw['requireElicitation'];
  }
  if (raw['allowSelfSigned'] !== undefined) {
    if (typeof raw['allowSelfSigned'] !== 'boolean') {
      throw new Error(`${source}: allowSelfSigned must be a boolean`);
    }
    config.allowSelfSigned = raw['allowSelfSigned'];
  }
  return config;
}

export function loadConfig(path: string): ServerConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Config file not found at ${path} — create it (see the README for the format) ` +
          'or point at one with --config / TRUENAS_MCP_CONFIG',
      );
    }
    throw error;
  }
  warnIfBroadlyReadable(path);
  return parseConfig(text, path);
}

/** The file holds API keys (S3.1); nag on stderr if others can read it. */
function warnIfBroadlyReadable(path: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      console.error(
        `Warning: ${path} is readable by other users and contains API keys — ` +
          `consider "chmod 600 ${path}"`,
      );
    }
  } catch {
    // Advisory only — never block startup on a stat failure.
  }
}

/**
 * Applies {@link ServerConfig.allowSelfSigned} to the process. Returns a
 * restore function — init's verification undoes it; the server leaves it in
 * place for its lifetime.
 */
export function applyTlsPolicy(config: ServerConfig): () => void {
  if (config.allowSelfSigned !== true) {
    return () => undefined;
  }
  const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  return () => {
    if (previous === undefined) {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    } else {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
    }
  };
}

export function fileCredentialProvider(config: ServerConfig): CredentialProvider {
  return {
    getSystems: () => Promise.resolve(config.systems),
  };
}
