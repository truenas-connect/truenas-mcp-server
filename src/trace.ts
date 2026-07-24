import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Creates the trace file (and parent directories) up front, so an unusable
 * path fails loudly at startup — before anything is serving — instead of
 * killing an already-connected server when the first frame arrives.
 */
export function prepareTraceFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Frames include confirmation tokens and tool arguments — created 0600.
  appendFileSync(path, '', { mode: 0o600 });
}

/**
 * Debug facility: appends every JSON-RPC frame crossing the transport — both
 * directions — as JSONL, so a session driven by an MCP host (Claude Desktop)
 * can be observed with `tail -f trace.jsonl | jq`.
 *
 * Must be called AFTER the server is connected: the SDK assigns
 * `transport.onmessage` during connect, and this wraps whatever is there.
 * Frames delivered before the wrap is installed would be missed — in practice
 * none are, because connect resolves before the event loop reads the first
 * stdin bytes, so even the initialize handshake is captured.
 * Synchronous appends keep frame ordering exact; this is a debug tool, not a
 * production path.
 */
export function enableTracing(transport: Transport, path: string): void {
  const record = (dir: 'recv' | 'send', message: unknown): void => {
    try {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), dir, message })}\n`, {
        mode: 0o600,
      });
    } catch {
      // Tracing must never break the server.
    }
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    record('send', message);
    return send(message, options);
  };
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    record('recv', message);
    onmessage?.(message, extra);
  };
}
