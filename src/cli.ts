#!/usr/bin/env node
/**
 * Standalone TrueNAS MCP server — stdio entrypoint (ER-172 C1.1–C1.3).
 * Launched by an MCP host (Claude Desktop, MCP Inspector, ...); stdout is the
 * MCP channel, so every human-facing message goes to stderr.
 */

import { parseArgs } from 'node:util';
import { defaultConfigPath, expandTilde, loadConfig, resolveConfigPath } from '@/config';
import { runInit } from '@/init';
import { runServer } from '@/run';
import { VERSION } from '@/version';

const USAGE = `truenas-mcp-server — TrueNAS MCP server over stdio

Usage:
  truenas-mcp-server [options]         Run the MCP server (launched by an MCP host)
  truenas-mcp-server init [options]    Create the config file interactively

Options:
  -c, --config <path>  Config file (default: $TRUENAS_MCP_CONFIG, then ${defaultConfigPath()})
      --force          init: overwrite an existing config file without asking
      --trace <path>   Append every MCP JSON-RPC frame (both directions) to a
                       JSONL file (also via $TRUENAS_MCP_TRACE)
  -h, --help           Show this help
  -v, --version        Show the version

The config file format and MCP host wiring are documented in the README.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      force: { type: 'boolean' },
      trace: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || (command !== 'serve' && command !== 'init')) {
    throw new Error(`Unknown command "${positionals.join(' ')}"\n\n${USAGE}`);
  }

  const configPath = resolveConfigPath(values.config);
  if (command === 'init') {
    const ok = await runInit({ path: configPath, force: values.force });
    // Exit explicitly: a verification timeout abandons an in-flight connect
    // whose retrying sockets would otherwise keep the event loop alive
    // forever. Flush stdout first — process.exit can drop buffered pipe
    // writes.
    await new Promise((resolve) => process.stdout.write('', () => resolve(undefined)));
    process.exit(ok ? 0 : 1);
  }

  const config = loadConfig(configPath);
  const traceOption = values.trace ?? process.env['TRUENAS_MCP_TRACE'];
  const tracePath = traceOption === undefined ? undefined : expandTilde(traceOption);
  // Everything from TLS policy through connect and serve lives in runServer,
  // so the tier-2 fixture and this binary drive identical wiring.
  await runServer(config, {
    configPath,
    ...(tracePath !== undefined ? { tracePath } : {}),
  });
}

main().catch((error: unknown) => {
  // Printed verbatim on the assumption that core/api-client errors never
  // embed credentials (keys live only in the config file).
  //
  // Expected failures — ours today, and any future core subclasses
  // (ConfigError, AuthError, ...) — are Error-derived with curated messages
  // and print message-only. Bugs are overwhelmingly native error types
  // (TypeError & co.) or messageless, and get their stack. parseArgs signals
  // CLI misuse via TypeErrors with ERR_PARSE_ARGS codes — user error, not a
  // bug. TRUENAS_MCP_DEBUG forces the stack for everything.
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const parseArgsError = typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
    const bugLike =
      !parseArgsError &&
      (error.message.length === 0 ||
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof ReferenceError ||
        error instanceof SyntaxError);
    const showStack = bugLike || process.env['TRUENAS_MCP_DEBUG'] !== undefined;
    console.error(showStack ? (error.stack ?? error.message) : error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
