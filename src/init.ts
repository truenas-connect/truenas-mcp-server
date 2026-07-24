/**
 * `truenas-mcp-server init` — interactive creation of the config file, so the
 * "one file the user writes once" doesn't have to be written by hand.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import {
  SystemRegistry,
  assertValidSystemName,
  connectSystems,
  defaultClientFactory,
  type ClientFactory,
} from '@truenas/mcp-base';
import { applyTlsPolicy, parseConfig } from '@/config';

/** Interactive input (stdin) ended before the questions were answered. */
export class InputEndedError extends Error {
  constructor() {
    super('Input ended before all questions were answered');
  }
}

export interface InitOptions {
  /** Where to write the config file. */
  path: string;
  /** Overwrite an existing file without asking. */
  force?: boolean;
  /** Injectable I/O for tests; defaults to stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Injectable for tests; defaults to the core's API-key factory. */
  clientFactory?: ClientFactory;
  /**
   * Cap on the connectivity verification, default 10s. The client's connection
   * layer retries indefinitely, so an unreachable host would otherwise hang.
   */
  verifyTimeoutMs?: number;
}

interface AskOptions {
  def?: string;
  /** Default true; false lets an empty answer through as ''. */
  required?: boolean;
  /** Mask the echo with '*' while typing (API keys). */
  secret?: boolean;
  /** Returns a problem description to re-prompt with, or undefined if valid. */
  validate?: (value: string) => string | undefined;
}

/** The on-disk shape (parseConfig's input), not the parsed SystemSpec. */
interface FileSystemEntry {
  name: string;
  host?: string;
  hostnames?: string[];
  username: string;
  apiKey: string;
}

/** Returns false when aborted or when the post-write verification failed. */
export async function runInit(options: InitOptions): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const write = (text: string): void => void output.write(text);

  // Echo goes through this gate so secrets are masked while typed. When
  // `masked` holds the prompt, every readline echo (a typed character, a
  // backspace redraw, ...) is replaced by redrawing the whole line as
  // prompt + one '*' per character in the buffer — editing stays consistent.
  let masked: string | null = null;
  const rl = createInterface({
    input,
    output: new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        if (masked === null) {
          output.write(chunk);
        } else {
          // One '*' per character: the length stays visible — the standard
          // password-field trade-off, accepted for typo feedback.
          output.write(`\u001B[2K\r${masked}${'*'.repeat(rl.line.length)}`);
        }
        done();
      },
    }),
    terminal: 'isTTY' in input && (input as NodeJS.ReadStream).isTTY === true,
  });

  // Buffer lines instead of using rl.question(): answers arriving while no
  // question is pending (piped stdin, paste-ahead) would otherwise be dropped.
  const buffered: string[] = [];
  const pending: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  let inputEnded = false;
  rl.on('line', (line) => {
    const waiter = pending.shift();
    if (waiter) {
      waiter.resolve(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on('close', () => {
    inputEnded = true;
    for (const waiter of pending.splice(0)) {
      waiter.reject(new InputEndedError());
    }
  });
  const nextLine = (): Promise<string> => {
    const line = buffered.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (inputEnded) {
      return Promise.reject(new InputEndedError());
    }
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };

  const ask = async (question: string, opts: AskOptions = {}): Promise<string> => {
    for (;;) {
      const prompt = opts.def !== undefined ? `${question} [${opts.def}]: ` : `${question}: `;
      write(prompt);
      masked = opts.secret === true ? prompt : null;
      let raw: string;
      try {
        raw = await nextLine();
      } finally {
        if (masked !== null) {
          masked = null;
          write('\n');
        }
      }
      const value = raw.trim() === '' && opts.def !== undefined ? opts.def : raw.trim();
      if (value === '') {
        if (opts.required === false) {
          return '';
        }
        write('  A value is required\n');
        continue;
      }
      const problem = opts.validate?.(value);
      if (problem !== undefined) {
        write(`  ${problem}\n`);
        continue;
      }
      return value;
    }
  };

  const confirm = async (question: string, def: boolean): Promise<boolean> => {
    for (;;) {
      write(`${question} [${def ? 'Y/n' : 'y/N'}]: `);
      const raw = (await nextLine()).trim().toLowerCase();
      if (raw === '') {
        return def;
      }
      if (raw === 'y' || raw === 'yes') {
        return true;
      }
      if (raw === 'n' || raw === 'no') {
        return false;
      }
      write('  Please answer y or n\n');
    }
  };

  try {
    if (existsSync(options.path) && options.force !== true) {
      if (!(await confirm(`${options.path} already exists — overwrite it?`, false))) {
        write('Aborted — the existing config was left untouched.\n');
        return false;
      }
    }
    write(`Creating ${options.path}\n\n`);

    const entries: FileSystemEntry[] = [];
    do {
      write(entries.length === 0 ? 'First TrueNAS system:\n' : `System ${entries.length + 1}:\n`);
      const name = await ask('  Name (how the LLM will refer to it)', {
        ...(entries.length === 0 ? { def: 'truenas' } : {}),
        validate: (value) => {
          try {
            assertValidSystemName(value);
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
          if (entries.some((entry) => entry.name === value)) {
            return `"${value}" is already used by another system in this config`;
          }
          return undefined;
        },
      });
      const splitHosts = (value: string): string[] =>
        value
          .split(',')
          .map((host) => host.trim())
          .filter((host) => host !== '');
      // Validated here, not left to the final parseConfig round-trip: an
      // answer like "," would otherwise crash after every remaining question
      // has been answered instead of re-prompting this one field.
      const hostnames = splitHosts(
        await ask('  Host (comma-separate fallback hosts)', {
          validate: (value) =>
            splitHosts(value).length === 0 ? 'At least one host is required' : undefined,
        }),
      );
      const username = await ask('  Username the API key belongs to', { def: 'truenas_admin' });
      const apiKey = await ask('  API key (input masked)', { secret: true });
      entries.push({
        name,
        ...(hostnames.length === 1 ? { host: hostnames[0] } : { hostnames }),
        username,
        apiKey,
      });
    } while (await confirm('Add another system?', false));

    write('\nTrueNAS ships a self-signed TLS certificate by default. Allowing it\n');
    write('disables certificate verification for ALL configured systems.\n');
    const allowSelfSigned = await confirm('Allow self-signed certificates?', false);

    const auditLog = await ask('JSONL audit log path (empty = audit to stderr)', {
      required: false,
    });

    const text = `${JSON.stringify(
      {
        systems: entries,
        ...(allowSelfSigned ? { allowSelfSigned: true } : {}),
        ...(auditLog ? { auditLog } : {}),
      },
      null,
      2,
    )}\n`;
    // Round-trip through the real parser so init can never write a config the
    // server would then refuse to load.
    const config = parseConfig(text, options.path);

    mkdirSync(dirname(options.path), { recursive: true });
    writeFileSync(options.path, text, { mode: 0o600 });
    if (process.platform !== 'win32') {
      // writeFileSync's mode only applies on creation; enforce it on overwrite too.
      chmodSync(options.path, 0o600);
    }
    write(`\nWrote ${options.path} (mode 600 — it contains API keys)\n`);

    if (await confirm('Verify connectivity to the configured system(s) now?', true)) {
      const timeoutMs = options.verifyTimeoutMs ?? 10_000;
      const registry = new SystemRegistry();
      const restoreTls = applyTlsPolicy(config);
      // Track every client the factory hands back: on timeout connectSystems
      // is abandoned mid-flight, and those clients are not yet in the registry
      // — but their retrying sockets would keep the event loop alive.
      const created: Awaited<ReturnType<ClientFactory>>[] = [];
      const factory = options.clientFactory ?? defaultClientFactory;
      const trackingFactory: ClientFactory = async (spec) => {
        const client = await factory(spec);
        created.push(client);
        return client;
      };
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          connectSystems(
            registry,
            { getSystems: () => Promise.resolve(config.systems) },
            trackingFactory,
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Timed out after ${timeoutMs / 1000}s — system unreachable or not responding`,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
        write(`✓ Connected and authenticated: ${registry.names().join(', ')}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        write(`✗ ${message}\n`);
        if (config.allowSelfSigned !== true && /self[ -]?signed|certificate/i.test(message)) {
          write('  Self-signed certificate? Re-run "init" and allow self-signed certificates.\n');
        }
        write('  The config file was written anyway — fix the values and re-run "init".\n');
        return false;
      } finally {
        clearTimeout(timer);
        restoreTls();
        // Everything registered came through the tracking factory, so closing
        // `created` covers registered and still-unregistered clients alike.
        // (A client stuck INSIDE its factory remains unreachable — the CLI's
        // explicit exit after init is the backstop for that case.)
        for (const client of created) {
          try {
            client.close();
          } catch {
            // Best-effort; connectSystems may have closed it already.
          }
        }
      }
    }

    write('\nDone. Point your MCP host at truenas-mcp-server (README has a Claude Desktop snippet).\n');
    return true;
  } catch (error) {
    if (error instanceof InputEndedError) {
      // Piped stdin ran out of answers, or the user hit Ctrl-D: an expected
      // way to leave, not a crash.
      write('\nInput ended before setup finished — aborting.\n');
      return false;
    }
    throw error;
  } finally {
    rl.close();
  }
}
