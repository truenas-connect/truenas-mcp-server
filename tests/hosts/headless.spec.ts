import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultCatalog, Role } from '@truenas/mcp-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapters } from './adapters';
import {
  elicitationAnswers,
  hostEnv,
  hostOnPath,
  readAudit,
  readTrace,
  SESSION_PROMPT,
  setUpFixture,
  type TraceFrame,
} from './harness';

/**
 * Tier 3, headless (testing-plan Phase 5): one real host, one prompt, all
 * assertions read from our server's --trace and audit JSONL — never from
 * model prose. The load-bearing one is the negative: an unattended host must
 * never answer an elicitation with "accept". A host that did would silently
 * run mutations nobody approved, and no lower tier can see that.
 */

const expectedTools = createDefaultCatalog()
  .list(Role.Full)
  .map((tool) => tool.name)
  .sort();

for (const adapter of adapters) {
  describe.skipIf(!hostOnPath(adapter.command))(`${adapter.name} (headless)`, () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tnmcp-hosts-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('advertises, routes, gates — and never answers accept unattended', async () => {
      const { mcpConfigPath, tracePath, auditPath } = setUpFixture(dir);

      const child = spawn(adapter.command, adapter.headlessArgs(mcpConfigPath, SESSION_PROMPT), {
        env: hostEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
      const killer = setTimeout(() => child.kill('SIGKILL'), 240_000);
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
      }).finally(() => clearTimeout(killer));
      // The host's own output is context for humans debugging a failure, not
      // an assertion substrate.
      expect(exitCode, Buffer.concat(output).toString().slice(-2000)).toBe(0);

      const frames = readTrace(tracePath);
      const recv = (method: string): TraceFrame[] =>
        frames.filter((f) => f.dir === 'recv' && f.message.method === method);

      // The host advertises what the adapter claims it does.
      const initialize = recv('initialize')[0];
      expect(initialize).toBeDefined();
      const capabilities = initialize?.message.params?.['capabilities'] as
        | Record<string, unknown>
        | undefined;
      expect(capabilities?.['elicitation'] !== undefined).toBe(adapter.expectsElicitation);

      // tools/list returned the full default catalog.
      const listId = recv('tools/list')[0]?.message.id;
      expect(listId).toBeDefined();
      const listResult = frames.find((f) => f.dir === 'send' && f.message.id === listId);
      const advertised = (
        (listResult?.message.result?.['tools'] as { name: string }[] | undefined) ?? []
      )
        .map((tool) => tool.name)
        .sort();
      expect(advertised).toEqual(expectedTools);

      // The read-only call round-tripped through the fixture.
      const audit = readAudit(auditPath);
      expect(audit.some((e) => e.tool === 'storage_pool_status' && e.phase === 'read')).toBe(true);

      // The mutating call was gated: elicitation sent, carrying the plan.
      const elicit = frames.find((f) => f.dir === 'send' && f.message.method === 'elicitation/create');
      expect(elicit).toBeDefined();
      expect(elicit?.message.params?.['message']).toContain('tank/data@probe');

      // THE tier-3 assertion: unattended, the host never answers accept.
      const answers = elicitationAnswers(frames);
      expect(answers.length).toBeGreaterThan(0);
      for (const answer of answers) {
        expect(answer).not.toBe('accept');
      }

      // And the non-accept executed nothing and leaked no token: the plan
      // phase was audited, the execute phase never happened, and no fallback
      // token appeared in any response.
      expect(audit.some((e) => e.tool === 'snapshots_create' && e.phase === 'plan')).toBe(true);
      expect(audit.some((e) => e.phase === 'execute')).toBe(false);
      // The minted-token line, specifically: tools/list legitimately carries
      // the string "Confirmation token" in the reserved argument's schema
      // description, which is metadata, not a token.
      expect(JSON.stringify(frames)).not.toContain('Confirmation token (single-use');
    });
  });
}
