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
      // once after the file is guaranteed to exist. A failure must not block
      // auditing, but it must not be silent either: the file carries tool
      // arguments (mirrors config.ts's warnIfBroadlyReadable).
      modeEnsured = true;
      if (process.platform !== 'win32') {
        await chmod(path, 0o600).catch((error: unknown) => {
          console.error(
            `Warning: could not restrict ${path} to mode 600 ` +
              `(${error instanceof Error ? error.message : String(error)}) — ` +
              'the audit log may be readable by other users',
          );
        });
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
    async flush() {
      // A record() enqueued while the drain is in flight chains onto a tail
      // this flush never captured — re-read until stable, so a shutdown
      // racing a last-moment write still drains it. Unbounded enqueueing
      // cannot hang exit: the shutdown drain is capped by drainTimeoutMs.
      for (;;) {
        const current = tail;
        await current;
        if (current === tail) {
          return;
        }
      }
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
