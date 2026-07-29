export interface ShutdownDeps {
  /** Drains pending audit writes (ER-172 S3.3). */
  flush(): Promise<void>;
  /** Closes the registry's API clients. */
  close(): void;
  exit(code: number): void;
  /** Cap on the audit drain so a stuck disk cannot hang exit. Default 2s. */
  drainTimeoutMs?: number;
}

/**
 * Builds the process shutdown handler: drain audit, close clients, exit —
 * so the last action before a host quits is recorded. Idempotent, because
 * signals and the transport closing can race each other.
 */
export function createShutdown(deps: ShutdownDeps): () => void {
  let started = false;
  return () => {
    if (started) {
      return;
    }
    started = true;
    void (async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        deps.flush().catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, deps.drainTimeoutMs ?? 2000);
        }),
      ]);
      // Self-contained even with a non-exiting injected exit (tests): a
      // dangling timer would keep the event loop alive.
      clearTimeout(timer);
      try {
        deps.close();
      } catch {
        // Best-effort on the way out.
      }
      deps.exit(0);
    })();
  };
}
