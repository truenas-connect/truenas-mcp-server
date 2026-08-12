/**
 * Connect-and-serve: the wiring behind the `serve` command, in one exported
 * unit so the tier-2 stdio fixture drives the exact path the production
 * binary does — same credential provider, same rollback, same trace ordering.
 * The client factory is the only injectable, mirroring the seam `init.ts`
 * already has; there is deliberately no environment-variable override for it.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ConfirmationService,
  SystemRegistry,
  ToolExecutor,
  connectSystems,
  createDefaultCatalog,
  defaultClientFactory,
  type ClientFactory,
} from '@truenas/mcp-base';
import { createAuditSink } from '@/audit';
import { applyTlsPolicy, fileCredentialProvider, type ServerConfig } from '@/config';
import { createServer } from '@/server';
import { createShutdown } from '@/shutdown';
import { enableTracing, prepareTraceFile } from '@/trace';
import { VERSION } from '@/version';

export interface RunServerOptions {
  /** Where the config was loaded from; reported in the startup banner. */
  configPath: string;
  /** JSONL file receiving every MCP frame; must be usable or startup fails. */
  tracePath?: string;
  /** Injectable for tests; defaults to the core's API-key factory. */
  clientFactory?: ClientFactory;
}

/**
 * Connects the configured systems and starts serving. The returned promise
 * settles at the end of *startup*: it resolves once the transport is connected
 * and the banner printed (the process then stays alive via the open stdio
 * handles and signal handlers), and rejects on startup failure after closing
 * any clients that already connected.
 */
export async function runServer(config: ServerConfig, options: RunServerOptions): Promise<void> {
  // TLS policy must be applied before connecting: clients read the
  // process-global setting at connect time. The restore function
  // applyTlsPolicy returns is deliberately discarded — safe only because
  // runServer owns the process for its lifetime. An in-process caller (e.g. a
  // test) using allowSelfSigned would leak the weakened process-global TLS
  // setting to everything after it; such callers must isolate the process, as
  // the subprocess-based tier-2 fixture does.
  if (config.allowSelfSigned === true) {
    applyTlsPolicy(config);
    console.error(
      'Warning: "allowSelfSigned" is enabled — TLS certificate verification is ' +
        'disabled for all systems.',
    );
  }

  if (options.tracePath !== undefined) {
    // An unusable path must fail here, before anything is serving.
    prepareTraceFile(options.tracePath);
  }

  const registry = new SystemRegistry();
  // Closes its own clients when any system fails to connect.
  await connectSystems(
    registry,
    fileCredentialProvider(config),
    options.clientFactory ?? defaultClientFactory,
  );
  try {
    await serve(registry, config, options);
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
  options: RunServerOptions,
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
  const server = createServer({
    catalog,
    executor,
    confirmations,
    ...(config.requireElicitation !== undefined
      ? { requireElicitation: config.requireElicitation }
      : {}),
  });

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
  if (options.tracePath !== undefined) {
    // After connect (the SDK assigns transport.onmessage there) and with NO
    // intervening await: any frame processed before the wrap is installed
    // would bypass the trace.
    enableTracing(transport, options.tracePath);
    console.error(`Tracing MCP frames to ${options.tracePath}`);
  }
  console.error(
    `truenas-mcp-server ${VERSION}: serving ${registry.names().join(', ')} ` +
      `over stdio (config: ${options.configPath})`,
  );
}
