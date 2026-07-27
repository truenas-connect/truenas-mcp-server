import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type AuditEvent, type AuditSink } from '@truenas/mcp-base';
import type { ServerConfig } from '@/config';

export interface FlushableAuditSink extends AuditSink {
  /** Resolves once every record() accepted so far has been written. */
  flush(): Promise<void>;
}

/**
 * Appends one JSON line per audit event (ER-172 S3.3, V5.1). Failures
 * propagate to the executor's onAuditError handler — they never alter tool
 * control flow (that guarantee lives in the core).
 *
 * Writes are serialized through a single tail promise: line ordering is
 * deterministic, and shutdown can drain in-flight writes via flush() so the
 * last mutating action before a host quits is not lost.
 */
export function jsonlAuditSink(path: string): FlushableAuditSink {
  let dirReady: Promise<unknown> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let modeEnsured = false;

  const append = async (event: AuditEvent): Promise<void> => {
    dirReady ??= mkdir(dirname(path), { recursive: true });
    try {
      await dirReady;
    } catch (error) {
      // Let the next record retry the mkdir instead of failing forever.
      dirReady = undefined;
      throw error;
    }
    // Audit events carry tool arguments; match the config file's hygiene.
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (!modeEnsured) {
      // The creation mode does not apply to a pre-existing file — tighten it
      // once, best-effort, after the file is guaranteed to exist.
      modeEnsured = true;
      if (process.platform !== 'win32') {
        await chmod(path, 0o600).catch(() => undefined);
      }
    }
  };

  return {
    record(event) {
      // tail never rejects (failures are captured below), so chaining off it
      // cannot swallow this record's own failure.
      const result = tail.then(() => append(event));
      tail = result.catch(() => undefined);
      return result;
    },
    flush() {
      return tail.then(() => undefined);
    },
  };
}

export function createAuditSink(config: ServerConfig): FlushableAuditSink {
  if (config.auditLog !== undefined) {
    return jsonlAuditSink(config.auditLog);
  }
  // Deliberately implemented here rather than delegating to the core's
  // console sink: stdout is the MCP channel, and this adapter's protocol
  // hygiene must not depend on another package's choice of stream. Writes
  // synchronously to stderr; nothing to drain.
  return {
    record: (event) => {
      console.error(`[audit] ${JSON.stringify(event)}`);
    },
    flush: () => Promise.resolve(),
  };
}
