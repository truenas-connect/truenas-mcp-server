import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultCatalog, Role } from '@truenas/mcp-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterAvailable, adapters } from './adapters';
import {
  elicitationAnswers,
  hostEnv,
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
 * run mutations nobody approved, and no lower tier can see that. Hosts fail
 * closed in different shapes (see HostAdapter.unattendedElicitation); what
 * they must have in common is the absence of an accept.
 */

const expectedTools = createDefaultCatalog()
  .list(Role.Full)
  .map((tool) => tool.name)
  .sort();

for (const adapter of adapters) {
  describe.skipIf(!adapterAvailable(adapter))(`${adapter.name} (headless)`, () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tnmcp-hosts-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('advertises, routes, gates — and never answers accept unattended', async () => {
      const fixture = setUpFixture(dir);

      const child = spawn(adapter.command, adapter.headlessArgs(fixture, SESSION_PROMPT), {
        env: { ...hostEnv(), ...adapter.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
      const killer = setTimeout(() => child.kill('SIGKILL'), 540_000);
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
      }).finally(() => clearTimeout(killer));
      const hostOutput = Buffer.concat(output).toString().slice(-2000);

      const frames = readTrace(fixture.tracePath);
      const recv = (method: string): TraceFrame[] =>
        frames.filter((f) => f.dir === 'recv' && f.message.method === method);

      // The host advertises what the adapter claims it does.
      const initialize = recv('initialize')[0];
      expect(initialize, hostOutput).toBeDefined();
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
      const audit = readAudit(fixture.auditPath);
      expect(audit.some((e) => e.tool === 'storage_pool_status' && e.phase === 'read'), hostOutput).toBe(
        true,
      );

      // The mutating call was gated: elicitation sent, carrying the plan.
      const elicit = frames.find(
        (f) => f.dir === 'send' && f.message.method === 'elicitation/create',
      );
      expect(elicit, hostOutput).toBeDefined();
      expect(elicit?.message.params?.['message']).toContain('tank/data@probe');

      // THE tier-3 assertion: unattended, the host never answers accept —
      // whether it fails closed by answering non-accept or by erroring out
      // without answering at all.
      const answers = elicitationAnswers(frames);
      if (adapter.unattendedElicitation === 'answers-non-accept') {
        expect(exitCode, hostOutput).toBe(0);
        expect(answers.length).toBeGreaterThan(0);
        for (const answer of answers) {
          expect(answer).not.toBe('accept');
        }
      } else {
        // errors-without-answering: no answer frame ever arrives, and the
        // host reports the failure through its exit code.
        expect(answers).toEqual([]);
        expect(exitCode, hostOutput).not.toBe(0);
      }

      // And nothing executed and no token leaked: the plan phase was
      // audited, the execute phase never happened, and no minted token
      // appears in any frame. (tools/list legitimately carries the string
      // "Confirmation token" in the reserved argument's schema description,
      // hence the minted-line needle.)
      expect(audit.some((e) => e.tool === 'snapshots_create' && e.phase === 'plan')).toBe(true);
      expect(audit.some((e) => e.phase === 'execute')).toBe(false);
      expect(JSON.stringify(frames)).not.toContain('Confirmation token (single-use');
    });
  });
}
