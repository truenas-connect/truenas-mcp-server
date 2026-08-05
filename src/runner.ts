/**
 * Connect-and-serve: everything between "a parsed config" and "an MCP server
 * running over a transport". Extracted from `cli.ts` so the same wiring the
 * binary uses can be driven by tests, rather than reimplemented alongside it
 * (testing-plan Phase 2).
 *
 * `cli.ts` keeps argument parsing and config loading; this module owns the
 * rest, including the process-global TLS policy — see {@link RunServerOptions}
 * for why that boundary sits here.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ConfirmationService,
  SystemRegistry,
  ToolExecutor,
  connectSystems,
  createDefaultCatalog,
  type ClientFactory,
} from '@truenas/mcp-base';
import { createAuditSink } from '@/audit';
import { applyTlsPolicy, fileCredentialProvider, type ServerConfig } from '@/config';
import { createServer } from '@/server';
import { createShutdown } from '@/shutdown';
import { enableTracing, prepareTraceFile } from '@/trace';
import { VERSION } from '@/version';

export interface RunServerOptions {
  /** Reported in the startup banner so the operator can see which file won. */
  configPath: string;
  /** Already tilde-expanded by the caller. */
  tracePath?: string;
  /**
   * Injectable for tests; defaults to the core's API-key factory. Mirrors
   * {@link import('@/init').InitOptions.clientFactory} — the seam `init.ts`
   * has always had and the serve path did not.
   */
  clientFactory?: ClientFactory;
  /**
   * Injectable for tests; defaults to stdio. Tests that drove the real one
   * would seize the process's stdin/stdout, and stdout is the MCP channel.
   */
  transport?: Transport;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export interface RunningServer {
  /** Registered system names, in registry order. */
  systems: string[];
  /**
   * Removes the signal handlers this call installed. The binary never needs
   * it — the process is ending anyway — but a test that ran without it would
   * leak a listener per call and eventually trip Node's max-listeners warning.
   */
  dispose(): void;
}

/**
 * Connects every configured system, then serves MCP over `transport`.
 *
 * Two ordering invariants live here and must survive any refactor:
 *
 * 1. The trace file is prepared before anything serves, so an unusable path
 *    fails at startup instead of killing an already-connected server.
 * 2. {@link enableTracing} runs immediately after `server.connect`, with no
 *    intervening `await` — the SDK assigns `transport.onmessage` during
 *    connect, and a frame processed before the wrap is installed would bypass
 *    the trace entirely.
 *
 * TLS policy is applied here rather than by the caller because it must take
 * effect before {@link connectSystems} — clients read the process-global
 * setting at connect time. Splitting the two across the boundary would make
 * that a caller contract whose breach silently rejects self-signed
 * certificates, with nothing in the error pointing at the cause.
 */
export async function runServer(
  config: ServerConfig,
  options: RunServerOptions,
): Promise<RunningServer> {
  if (config.allowSelfSigned === true) {
    applyTlsPolicy(config);
    console.error(
      'Warning: "allowSelfSigned" is enabled — TLS certificate verification is ' +
        'disabled for all systems.',
    );
  }

  if (options.tracePath !== undefined) {
    // Invariant 1: an unusable path must fail before anything is serving.
    prepareTraceFile(options.tracePath);
  }

  const registry = new SystemRegistry();
  // Closes its own clients when any system fails to connect.
  await connectSystems(registry, fileCredentialProvider(config), options.clientFactory);
  try {
    return await serve(registry, config, options);
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
): Promise<RunningServer> {
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

  // The two `??` defaults here and below (process.exit, StdioServerTransport)
  // are the only branches in this file coverage never sees. Taking them
  // in-process would end the test run or seize the MCP channel, which is why
  // they are injectable at all; the binary takes them on every real start, and
  // tier 2's subprocess tests exercise them there. Not worth a contrived test.
  const shutdown = createShutdown({
    flush: () => audit.flush(),
    close: () => registry.closeAll(),
    exit: options.exit ?? ((code) => process.exit(code)),
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The host closing stdio (e.g. Claude Desktop quitting) closes the transport.
  server.onclose = shutdown;

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
  if (options.tracePath !== undefined) {
    // Invariant 2: after connect, and with NO intervening await.
    enableTracing(transport, options.tracePath);
    console.error(`Tracing MCP frames to ${options.tracePath}`);
  }
  console.error(
    `truenas-mcp-server ${VERSION}: serving ${registry.names().join(', ')} ` +
      `over stdio (config: ${options.configPath})`,
  );

  return {
    systems: registry.names(),
    dispose: () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    },
  };
}
