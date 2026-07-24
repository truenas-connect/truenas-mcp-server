import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuditEvent } from '@truenas/mcp-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditSink, jsonlAuditSink } from '@/audit';

function event(tool: string): AuditEvent {
  return {
    at: 12345,
    tool,
    phase: 'read',
    mutating: false,
    args: {},
    outcomes: [{ system: 'a', outcome: 'ok' }],
  };
}

describe('jsonlAuditSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tnmcp-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per event, creating parent directories', async () => {
    const path = join(dir, 'nested', 'audit.jsonl');
    const sink = jsonlAuditSink(path);
    await sink.record(event('first'));
    await sink.record(event('second'));
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as AuditEvent).tool)).toEqual([
      'first',
      'second',
    ]);
    // Events carry tool arguments — same hygiene as the config file.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('flush resolves only after all accepted writes have landed', async () => {
    const path = join(dir, 'audit.jsonl');
    const sink = jsonlAuditSink(path);
    void sink.record(event('first'));
    void sink.record(event('second'));
    await sink.flush();
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });
});

describe('createAuditSink', () => {
  it('falls back to a flushable stderr sink without an auditLog path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const sink = createAuditSink({ systems: [] });
      sink.record(event('x'));
      await expect(sink.flush()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
