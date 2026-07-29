import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '@/shutdown';

function exitPromise(): { exit: (code: number) => void; exited: Promise<number> } {
  let resolve!: (code: number) => void;
  const exited = new Promise<number>((r) => (resolve = r));
  return { exit: (code) => resolve(code), exited };
}

describe('createShutdown', () => {
  it('drains the audit sink before closing and exiting', async () => {
    const order: string[] = [];
    const { exit, exited } = exitPromise();
    const shutdown = createShutdown({
      flush: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('flush');
      },
      close: () => order.push('close'),
      exit: (code) => {
        order.push('exit');
        exit(code);
      },
    });
    shutdown();
    expect(await exited).toBe(0);
    expect(order).toEqual(['flush', 'close', 'exit']);
  });

  it('caps the drain so a stuck sink cannot hang exit', async () => {
    const { exit, exited } = exitPromise();
    const shutdown = createShutdown({
      flush: () => new Promise<never>(() => undefined),
      close: () => undefined,
      exit,
      drainTimeoutMs: 30,
    });
    shutdown();
    expect(await exited).toBe(0);
  });

  it('still exits when flush rejects and close throws', async () => {
    const { exit, exited } = exitPromise();
    const shutdown = createShutdown({
      flush: () => Promise.reject(new Error('disk gone')),
      close: () => {
        throw new Error('already closed');
      },
      exit,
    });
    shutdown();
    expect(await exited).toBe(0);
  });

  it('is idempotent when signals and transport close race', async () => {
    const flush = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const shutdown = createShutdown({ flush, close: () => undefined, exit });
    shutdown();
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
