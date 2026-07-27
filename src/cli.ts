#!/usr/bin/env node
/**
 * Standalone TrueNAS MCP server — stdio entrypoint (ER-172 C1.1–C1.3).
 * Launched by an MCP host (Claude Desktop, MCP Inspector, ...); stdout is the
 * MCP channel, so every human-facing message goes to stderr.
 */

import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ConfirmationService,
  SystemRegistry,
  ToolExecutor,
  connectSystems,
  createDefaultCatalog,
} from '@truenas/mcp-base';
import { createAuditSink } from '@/audit';
import {
  applyTlsPolicy,
  defaultConfigPath,
  expandTilde,
  fileCredentialProvider,
  loadConfig,
  resolveConfigPath,
  type ServerConfig,
} from '@/config';
import { runInit } from '@/init';
import { createServer } from '@/server';
import { createShutdown } from '@/shutdown';
import { enableTracing, prepareTraceFile } from '@/trace';
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
  if (config.allowSelfSigned === true) {
    applyTlsPolicy(config);
    console.error(
      'Warning: "allowSelfSigned" is enabled — TLS certificate verification is ' +
        'disabled for all systems.',
    );
  }

  const traceOption = values.trace ?? process.env['TRUENAS_MCP_TRACE'];
  const tracePath = traceOption === undefined ? undefined : expandTilde(traceOption);
  if (tracePath !== undefined) {
    // An unusable path must fail here, before anything is serving.
    prepareTraceFile(tracePath);
  }

  const registry = new SystemRegistry();
  // Closes its own clients when any system fails to connect.
  await connectSystems(registry, fileCredentialProvider(config));
  try {
    await serve(registry, config, configPath, tracePath);
  } catch (error) {
    try {
      registry.closeAll();
    } catch {
      // The startup error is the one worth reporting.
    }
    throw error;
  }
}

async function serve(
  registry: SystemRegistry,
  config: ServerConfig,
  configPath: string,
  tracePath?: string,
): Promise<void> {
  const catalog = createDefaultCatalog();
  const confirmations = new ConfirmationService();
  const audit = createAuditSink(config);
  const executor = new ToolExecutor({
    catalog,
    registry,
    confirmations,
    audit,
    // Explicitly stderr: stdout is the MCP channel, and where audit failures
    // get reported must not depend on the core's default handler.
    onAuditError: (error, event) => {
      console.error(`Audit sink failed for ${event.tool}/${event.phase}:`, error);
    },
  });
  const server = createServer({ catalog, executor, confirmations });

  const shutdown = createShutdown({
    flush: () => audit.flush(),
    close: () => registry.closeAll(),
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The host closing stdio (e.g. Claude Desktop quitting) closes the transport.
  server.onclose = shutdown;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (tracePath !== undefined) {
    // After connect (the SDK assigns transport.onmessage there) and with NO
    // intervening await: any frame processed before the wrap is installed
    // would bypass the trace.
    enableTracing(transport, tracePath);
    console.error(`Tracing MCP frames to ${tracePath}`);
  }
  console.error(
    `truenas-mcp-server ${VERSION}: serving ${registry.names().join(', ')} ` +
      `over stdio (config: ${configPath})`,
  );
}

main().catch((error: unknown) => {
  // Printed verbatim on the assumption that core/api-client errors never
  // embed credentials (keys live only in the config file).
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
