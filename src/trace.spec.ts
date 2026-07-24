import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableTracing, prepareTraceFile } from '@/trace';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnmcp-trace-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('enableTracing', () => {
  it('records frames in both directions, preserving the existing handler', async () => {
    const path = join(dir, 'nested', 'trace.jsonl');
    prepareTraceFile(path);
    const [traced, peer] = InMemoryTransport.createLinkedPair();
    const seen: unknown[] = [];
    traced.onmessage = (message) => seen.push(message);
    await Promise.all([traced.start(), peer.start()]);

    enableTracing(traced, path);
    await peer.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await traced.send({ jsonrpc: '2.0', id: 1, result: {} });

    // The wrapped handler still delivers to the protocol layer.
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);

    const lines = readFileSync(path, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { at: string; dir: string; message: unknown });
    expect(lines.map((entry) => entry.dir)).toEqual(['recv', 'send']);
    expect(lines[0].message).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(lines[1].message).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(new Date(lines[0].at).getTime()).not.toBeNaN();
    // Frames include confirmation tokens and tool arguments.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('prepareTraceFile', () => {
  it('creates parent directories and an empty 0600 file up front', () => {
    const path = join(dir, 'a', 'b', 'trace.jsonl');
    prepareTraceFile(path);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('throws on an unusable path', () => {
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, '');
    expect(() => prepareTraceFile(join(blocker, 'trace.jsonl'))).toThrow();
  });
});
