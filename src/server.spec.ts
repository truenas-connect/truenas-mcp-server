import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { TrueNasApiClient } from '@truenas/api-client';
import {
  ConfirmationService,
  createDefaultCatalog,
  Role,
  SystemRegistry,
  ToolCatalog,
  ToolExecutor,
  type AuditEvent,
  type MutatingTool,
  type ReadOnlyTool,
  type SystemHandle,
  type SystemResult,
} from '@truenas/mcp-base';
import * as mcpBase from '@truenas/mcp-base';
import { describe, expect, it, vi } from 'vitest';
import { ElicitationGate } from '@/gate';
import { createServer } from '@/server';

interface SetupOptions {
  /** Undefined → client without elicitation capability (the fallback path). */
  onElicit?: (message: string) => ElicitResult | Promise<ElicitResult>;
  /** System names whose plan phase fails. */
  planFailsOn?: string[];
  elicitationTimeoutMs?: number;
  requireElicitation?: boolean;
}

// Guidance text deliberately contains brackets and braces: the JSON block
// extractor below must find the results by structure, not by the first '['.
const READ_GUIDANCE =
  'The value is "<system>-healthy"; anything else [including null] means the pool was not read.';
const MUTATING_GUIDANCE =
  '"created" names the snapshot {as the system reports it}; it does not confirm it is on disk.';

async function connectPair(server: Server, client: Client): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function setup(options: SetupOptions = {}) {
  const registry = new SystemRegistry();
  for (const name of ['a', 'b']) {
    registry.add({ name, client: {} as TrueNasApiClient } as SystemHandle);
  }

  const executeSpy = vi.fn(({ system }: { system: SystemHandle }) =>
    Promise.resolve({ created: `${system.name}-snap` }),
  );
  const mutatingTool: MutatingTool = {
    name: 'snap_create',
    description: 'test mutating tool',
    inputSchema: {
      type: 'object',
      properties: { dataset: { type: 'string' } },
      required: ['dataset'],
    },
    requiredRole: Role.Full,
    mutating: true,
    destructiveness: 'reversible',
    resultGuidance: MUTATING_GUIDANCE,
    normalizeArgs: (args) => {
      if (typeof args['dataset'] !== 'string') {
        throw new Error('"dataset" is required');
      }
      return { dataset: args['dataset'] };
    },
    plan: ({ system }, args) => {
      if (options.planFailsOn?.includes(system.name)) {
        return Promise.reject(new Error(`no such dataset on ${system.name}`));
      }
      return Promise.resolve([
        { method: 'snapshot.create', params: [args], description: `snapshot on ${system.name}` },
      ]);
    },
    execute: executeSpy,
  };
  const readTool: ReadOnlyTool = {
    name: 'pool_status',
    description: 'test read-only tool',
    inputSchema: { type: 'object', properties: {} },
    requiredRole: Role.ReadOnly,
    mutating: false,
    resultGuidance: READ_GUIDANCE,
    handler: ({ system }) => Promise.resolve(`${system.name}-healthy`),
  };

  const catalog = new ToolCatalog();
  catalog.register(mutatingTool);
  catalog.register(readTool);
  const confirmations = new ConfirmationService();
  const mintSpy = vi.spyOn(confirmations, 'mint');
  const auditEvents: AuditEvent[] = [];
  const executor = new ToolExecutor({
    catalog,
    registry,
    confirmations,
    audit: {
      record: (event) => {
        auditEvents.push(event);
      },
    },
  });
  const server = createServer({
    catalog,
    executor,
    confirmations,
    ...(options.elicitationTimeoutMs !== undefined
      ? { elicitationTimeoutMs: options.elicitationTimeoutMs }
      : {}),
    ...(options.requireElicitation !== undefined
      ? { requireElicitation: options.requireElicitation }
      : {}),
  });

  const elicitations: string[] = [];
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    options.onElicit ? { capabilities: { elicitation: {} } } : {},
  );
  if (options.onElicit) {
    const onElicit = options.onElicit;
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      elicitations.push(request.params.message);
      return onElicit(request.params.message);
    });
  }

  await connectPair(server, client);
  return { client, executeSpy, elicitations, auditEvents, mintSpy };
}

function text(result: unknown): string {
  const content = (result as CallToolResult).content;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return (content[0] as { type: 'text'; text: string }).text;
}

// Results are the pretty-printed JSON block: the only part of the body whose
// '[' and ']' each start a line, or the single line '[]'. Anything before it is
// a human-facing prefix and anything after it is result guidance, so the block
// is found by its own shape and neither neighbour can move it.
const RESULTS_BLOCK = /^(?:\[\]|\[[\s\S]*?^\])/m;

/**
 * The block's JSON and the index just past it. Ordering assertions take `end`
 * from here rather than re-deriving it: a hand-rolled `search(/^\]/m)` returns
 * -1 for the single-line `[]`, which any "guidance comes after the data" check
 * then passes without comparing anything.
 */
function resultsBlock(body: string): { json: string; end: number } {
  const match = RESULTS_BLOCK.exec(body);
  if (match === null) {
    throw new Error(`No results block in tool result body:\n${body}`);
  }
  return { json: match[0], end: match.index + match[0].length };
}

function parseResults(body: string): SystemResult<unknown>[] {
  return JSON.parse(resultsBlock(body).json) as SystemResult<unknown>[];
}

function guidanceBlock(body: string): string | undefined {
  const match = /\n\nHow to read (\S+) results \(sent once per session[^)]*\):\n([\s\S]*)$/.exec(
    body,
  );
  return match?.[2];
}

describe('tools/list', () => {
  it('advertises catalog tools with reserved args and annotations', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['pool_status', 'snap_create']);

    const snap = tools.find((tool) => tool.name === 'snap_create');
    expect(snap?.inputSchema['properties']).toHaveProperty('systems');
    expect(snap?.inputSchema['properties']).toHaveProperty('confirmation_token');
    expect(snap?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

    const pool = tools.find((tool) => tool.name === 'pool_status');
    expect(pool?.inputSchema['properties']).toHaveProperty('systems');
    expect(pool?.inputSchema['properties']).not.toHaveProperty('confirmation_token');
    expect(pool?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('keeps annotations agreeing with `mutating` for every default-catalog entry', async () => {
    const catalog = createDefaultCatalog();
    const server = createServer({
      catalog,
      executor: { execute: vi.fn() } as unknown as ToolExecutor,
      confirmations: new ConfirmationService(),
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' }, {});
    await connectPair(server, client);

    const advertised = catalog.list(Role.Full);
    expect(advertised.length).toBeGreaterThan(0);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      advertised.map((tool) => tool.name).sort(),
    );
    for (const entry of advertised) {
      const tool = tools.find((candidate) => candidate.name === entry.name);
      expect(tool?.annotations, entry.name).toEqual({
        readOnlyHint: !entry.mutating,
        destructiveHint: entry.mutating,
      });
      expect(tool?.inputSchema['properties'], entry.name).toHaveProperty('systems');
      if (entry.mutating) {
        expect(tool?.inputSchema['properties'], entry.name).toHaveProperty('confirmation_token');
      } else {
        expect(tool?.inputSchema['properties'], entry.name).not.toHaveProperty(
          'confirmation_token',
        );
      }
    }
  });

  // Tripwire, not a preference. Base #131 COPIED each tool's interpretation
  // guidance into `resultGuidance`; it did not move it, so the text ships
  // twice today — once in every `tools/list`, once appended to the first
  // data-bearing result. The follow-up that deletes the copies from
  // `description` is the change that actually shrinks the catalog, and it is
  // gated on an adapter rendering the field, which this one now does.
  //
  // Scanning the barrel rather than naming the two current carriers means
  // every barrel-exported tool base splits from here is covered without an
  // edit. "Barrel-exported" is the real limit and today it is not a narrowing
  // — base #152 pins the barrel's tool exports against the default catalog —
  // but that guarantee lives upstream, so the first assertion below pins the
  // two sets equal here rather than trusting it to hold.
  //
  // When this goes red, that follow-up has begun — and the failure names both
  // partitions, because the loop collects instead of throwing on the first
  // mismatch. Base is expected to split tool by tool, so a first-mismatch
  // assertion would report one carrier and hide the rest of the migration.
  //
  // The remedy depends on which state you are in, and only one of the two is
  // a matcher flip:
  //
  // - base has removed EVERY copy → invert this test, asserting `duplicated`
  //   is empty rather than `split`. It then proves the duplication is gone,
  //   and the payload win is measured here rather than asserted in a PR body.
  // - base is PART-WAY through → do not flip. Partition the expectation
  //   instead, listing the carriers already split; flipping the matcher
  //   mid-migration just fails on every carrier still holding its copy.
  it('still advertises every tool guidance in `description` — base has not removed the copies', () => {
    // Widened deliberately: the barrel's value union is every export's own
    // type, and the point here is to find tools by shape, not by name.
    const exported = (Object.values(mcpBase) as unknown[]).filter(
      (value): value is { name: string; description: string; resultGuidance?: string } =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { name?: unknown }).name === 'string' &&
        typeof (value as { description?: unknown }).description === 'string',
    );
    const carriers = exported.filter(
      (tool): tool is typeof tool & { resultGuidance: string } =>
        typeof tool.resultGuidance === 'string',
    );
    expect(carriers.length, 'no exported tool declares resultGuidance').toBeGreaterThan(0);

    const advertised = new Map(
      createDefaultCatalog()
        .list(Role.Full)
        .map((tool) => [tool.name, tool.description] as const),
    );
    // The scan's completeness precondition. The barrel is the ONLY place a
    // carrier can be found: `list()` strips `resultGuidance`, so a catalog tool
    // base stopped exporting would carry its guidance invisibly here with
    // nothing on the advertised side to report it against — the one gap the
    // `unregistered` partition below cannot cover. Pinning the two sets equal
    // is what stops the scan going quietly blind.
    expect(
      exported.map((tool) => tool.name).sort(),
      'the barrel and the default catalog have diverged, so this scan can no ' +
        'longer see every tool that might carry guidance',
    ).toEqual([...advertised.keys()].sort());
    const duplicated: string[] = [];
    const split: string[] = [];
    const unregistered: string[] = [];
    for (const tool of carriers) {
      const description = advertised.get(tool.name);
      if (description === undefined) {
        unregistered.push(tool.name);
        continue;
      }
      (description.includes(tool.resultGuidance) ? duplicated : split).push(tool.name);
    }
    // A carrier the default catalog does not register is beyond this
    // tripwire's reach, and skipping it quietly would let the test cover less
    // than its name claims — with two carriers today, one going unregistered
    // leaves the other holding the whole assertion. Nothing else guards this:
    // `tests/hosts/headless.spec.ts` builds its expectation from the same
    // `createDefaultCatalog()` it compares against, so it pins wire/catalog
    // AGREEMENT rather than membership, and it is tier 3 — nightly, never on
    // PRs. So the skip is reported below instead of assumed to be someone
    // else's.
    expect(
      duplicated.length + split.length,
      'no guidance carrier is in the default catalog',
    ).toBeGreaterThan(0);
    // One assertion over both partitions, not one each: a base bump can split
    // a description AND move a carrier out of the catalog in the same commit,
    // and sequential assertions would print the first and hide the second.
    // That is the first-failure-wins shape 40984c3 took out of the loop, and
    // it survives just as well in the assertions that consume it.
    expect(
      { unregistered, split },
      `${split.length} of ${split.length + duplicated.length} guidance carriers ` +
        `in the catalog have had their description copy removed. ` +
        `Split: ${split.join(', ') || 'none'}. ` +
        `Still duplicated: ${duplicated.join(', ') || 'none'}. ` +
        `Exported but not in the catalog, so invisible to this tripwire: ` +
        `${unregistered.join(', ') || 'none'}. ` +
        'See the comment above this test for which remedy applies.',
    ).toEqual({ unregistered: [], split: [] });
  });
});

describe('tools/call — read-only', () => {
  it('returns structured per-system results', async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: 'pool_status', arguments: { systems: 'all' } });
    expect(parseResults(text(result))).toEqual([
      { system: 'a', status: 'SUCCESS', value: 'a-healthy' },
      { system: 'b', status: 'SUCCESS', value: 'b-healthy' },
    ]);
  });

  it('maps executor errors to isError content', async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect((result as CallToolResult).isError).toBe(true);
    expect(text(result)).toMatch(/Unknown tool "no_such_tool"/);
  });

  it('treats an omitted "arguments" object as empty (registry then demands a selector)', async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: 'pool_status' });
    expect((result as CallToolResult).isError).toBe(true);
    expect(text(result)).toMatch(/Multiple systems are registered/);
  });
});

describe('tools/call — result guidance', () => {
  // The core attaches a tool's guidance to the first data-bearing result per
  // session and never advertises it; the adapter's job is to render it every
  // time it arrives, after the data it is about, and to render nothing when
  // the core says it was already delivered.
  it('renders read-only guidance once, after the results, and not on the next call', async () => {
    const { client } = await setup();
    const first = text(await client.callTool({ name: 'pool_status', arguments: { systems: 'all' } }));
    expect(parseResults(first)).toEqual([
      { system: 'a', status: 'SUCCESS', value: 'a-healthy' },
      { system: 'b', status: 'SUCCESS', value: 'b-healthy' },
    ]);
    expect(guidanceBlock(first)).toBe(READ_GUIDANCE);
    expect(first).toContain('How to read pool_status results');
    expect(first.indexOf(READ_GUIDANCE)).toBeGreaterThan(resultsBlock(first).end);

    const second = text(await client.callTool({ name: 'pool_status', arguments: { systems: 'all' } }));
    expect(parseResults(second)).toHaveLength(2);
    expect(guidanceBlock(second)).toBeUndefined();
    expect(second).not.toContain('How to read');
  });

  // An end-to-end claim, and deliberately not an adapter one: `tools/list`
  // carries no `resultGuidance` field. Base's `list()` strips it before the
  // adapter is ever handed an `AdvertisedTool`, so spreading the whole tool
  // inside `toMcpTool` leaks nothing and no mutation here can go red. Kept
  // because it is the property a host actually depends on, and because it
  // would break quietly if base ever started advertising the field.
  //
  // It is NOT the claim that the guidance TEXT is absent from `tools/list`.
  // Base #131 copied the text into `resultGuidance` rather than moving it, so
  // every real description still carries its own guidance verbatim; the
  // tripwire in the `tools/list` block above is what holds that, and what
  // goes red when base's follow-up finally removes the copies.
  it('tools/list carries no resultGuidance field', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool, tool.name).not.toHaveProperty('resultGuidance');
      // These fakes' descriptions omit their own guidance, so the strings pin
      // that `toMcpTool` invents no other route from the field to the wire.
      expect(JSON.stringify(tool), tool.name).not.toContain('healthy');
      expect(JSON.stringify(tool), tool.name).not.toContain('on disk');
    }
  });

  it('renders mutating guidance on the elicitation-approved execution', async () => {
    const { client } = await setup({ onElicit: () => ({ action: 'accept' }) });
    const body = text(
      await client.callTool({ name: 'snap_create', arguments: { dataset: 'tank/x', systems: 'all' } }),
    );
    expect(body.startsWith('Approved by the user in the client UI.')).toBe(true);
    expect(parseResults(body)).toHaveLength(2);
    expect(guidanceBlock(body)).toBe(MUTATING_GUIDANCE);
  });

  it('fallback path: the plan carries no guidance, the confirmed execution does', async () => {
    const { client } = await setup({ requireElicitation: false });
    const plan = text(
      await client.callTool({ name: 'snap_create', arguments: { dataset: 'tank/x', systems: 'all' } }),
    );
    expect(plan).not.toContain('How to read');
    expect(plan).not.toContain(MUTATING_GUIDANCE);
    const token = /Confirmation token \(single-use, expires\): (\S+)/.exec(plan)?.[1];

    const confirmed = text(
      await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all', confirmation_token: token },
      }),
    );
    expect(parseResults(confirmed)).toHaveLength(2);
    expect(guidanceBlock(confirmed)).toBe(MUTATING_GUIDANCE);
  });

  it('renders a bare results block when the outcome carries no guidance', async () => {
    const outcome = {
      type: 'RESULTS' as const,
      tool: 'pool_status',
      results: [{ system: 'a', status: 'SUCCESS' as const, value: 'a-healthy' }],
    };
    const executor = { execute: vi.fn().mockResolvedValue(outcome) } as unknown as ToolExecutor;
    const server = createServer({
      catalog: new ToolCatalog(),
      executor,
      confirmations: new ConfirmationService(),
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' }, {});
    await connectPair(server, client);

    const body = text(await client.callTool({ name: 'pool_status', arguments: {} }));
    expect(body).toBe(JSON.stringify(outcome.results, null, 2));
  });
});

describe('conformance matrix — {elicitation, none} × {requireElicitation unset, true, false}', () => {
  // Every cell of the matrix has an explicit test here.
  // Path details beyond the cell's core behavior (decline, timeout, partial
  // planning, audit, drift) live in the per-path describes below.
  describe('mutating calls', () => {
    it('elicitation client × unset: approved in the host UI, executed within one call', async () => {
      const { client, executeSpy, elicitations } = await setup({
        onElicit: () => ({ action: 'accept' }),
      });
      const result = await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all' },
      });
      expect(elicitations).toHaveLength(1);
      expect(elicitations[0]).toContain('snapshot on a');
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(parseResults(text(result))).toEqual([
        { system: 'a', status: 'SUCCESS', value: { created: 'a-snap' } },
        { system: 'b', status: 'SUCCESS', value: { created: 'b-snap' } },
      ]);
    });

    it('elicitation client × true: elicitation path unchanged', async () => {
      const { client, executeSpy, elicitations, mintSpy } = await setup({
        requireElicitation: true,
        onElicit: () => ({ action: 'accept' }),
      });
      const result = await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all' },
      });
      expect(elicitations).toHaveLength(1);
      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect((result as CallToolResult).isError).toBeUndefined();
      expect(text(result)).not.toContain('Confirmation token');
    });

    it('elicitation client × false: elicitation still wins over the fallback — no token in the response', async () => {
      const { client, executeSpy, elicitations, mintSpy } = await setup({
        requireElicitation: false,
        onElicit: () => ({ action: 'accept' }),
      });
      const result = await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all' },
      });
      expect(elicitations).toHaveLength(1);
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect((result as CallToolResult).isError).toBeUndefined();
      // A token IS minted — on the server side, after the user accepted — it
      // just never reaches the LLM's context.
      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(text(result)).not.toContain('Confirmation token');
    });

    it('no-elicitation client × unset: refused — no token minted, nothing executed', async () => {
      // The default is the safety-relevant half of this option: an operator who
      // never read the config docs must still get the refusal, not the fallback.
      const { client, executeSpy, auditEvents, mintSpy } = await setup();
      const result = await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all' },
      });
      expect((result as CallToolResult).isError).toBe(true);
      const body = text(result);
      expect(body).toContain('does not support elicitation');
      expect(body).not.toContain('Confirmation token');
      expect(mintSpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(auditEvents.map((event) => event.phase)).toEqual(['plan']);
    });

    it('no-elicitation client × true: refused — no token minted, nothing executed', async () => {
      const { client, executeSpy, auditEvents, mintSpy } = await setup({
        requireElicitation: true,
      });
      const result = await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all' },
      });
      expect((result as CallToolResult).isError).toBe(true);
      const body = text(result);
      expect(body).toContain('does not support elicitation');
      expect(body).not.toContain('Confirmation token');
      expect(mintSpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
      // The refusal happens after planning (that is how mutating calls are
      // detected), but nothing must reach the execute phase.
      expect(auditEvents.map((event) => event.phase)).toEqual(['plan']);
    });

    it('no-elicitation client × false: plan+token fallback, executes only on the confirmed call', async () => {
      const { client, executeSpy } = await setup({ requireElicitation: false });
      const planResult = await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all' },
      });
      const body = text(planResult);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(body).toContain('This is a plan — nothing has been executed.');
      expect(body).toContain('snapshot on a');

      const token = /Confirmation token \(single-use, expires\): (\S+)/.exec(body)?.[1];
      expect(token).toBeTruthy();

      const confirmed = await client.callTool({
        name: 'snap_create',
        arguments: { dataset: 'tank/x', systems: 'all', confirmation_token: token },
      });
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(parseResults(text(confirmed))).toEqual([
        { system: 'a', status: 'SUCCESS', value: { created: 'a-snap' } },
        { system: 'b', status: 'SUCCESS', value: { created: 'b-snap' } },
      ]);
    });
  });

  describe('read-only calls unaffected in every cell', () => {
    const accept = (): ElicitResult => ({ action: 'accept' });
    const cells: [string, SetupOptions][] = [
      ['elicitation client × unset', { onElicit: accept }],
      ['elicitation client × true', { onElicit: accept, requireElicitation: true }],
      ['elicitation client × false', { onElicit: accept, requireElicitation: false }],
      ['no-elicitation client × unset', {}],
      ['no-elicitation client × true', { requireElicitation: true }],
      ['no-elicitation client × false', { requireElicitation: false }],
    ];
    it.each(cells)('%s', async (_cell, options) => {
      const { client, elicitations, mintSpy } = await setup(options);
      const result = await client.callTool({ name: 'pool_status', arguments: { systems: 'all' } });
      expect((result as CallToolResult).isError).toBeUndefined();
      expect(parseResults(text(result))).toEqual([
        { system: 'a', status: 'SUCCESS', value: 'a-healthy' },
        { system: 'b', status: 'SUCCESS', value: 'b-healthy' },
      ]);
      expect(elicitations).toHaveLength(0);
      expect(mintSpy).not.toHaveBeenCalled();
    });
  });
});

describe('tools/call — mutating, elicitation path', () => {
  it('executes nothing when the user declines', async () => {
    const { client, executeSpy } = await setup({ onElicit: () => ({ action: 'decline' }) });
    const result = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect((result as CallToolResult).isError).toBeUndefined();
    expect(text(result)).toMatch(/declined.*nothing was executed/);
  });

  it('treats an unanswered elicitation as not approved instead of hanging', async () => {
    const { client, executeSpy } = await setup({
      onElicit: () => new Promise<ElicitResult>(() => undefined),
      elicitationTimeoutMs: 200,
    });
    const result = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect((result as CallToolResult).isError).toBeUndefined();
    expect(text(result)).toMatch(/declined.*nothing was executed/);
  });

  it('executes only on the systems that planned successfully', async () => {
    const { client, executeSpy, elicitations } = await setup({
      onElicit: () => ({ action: 'accept' }),
      planFailsOn: ['b'],
    });
    const result = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    expect(elicitations[0]).toContain('planning failed: no such dataset on b');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(parseResults(text(result))).toEqual([
      { system: 'a', status: 'SUCCESS', value: { created: 'a-snap' } },
    ]);
  });
});

describe('tools/call — internal invariants', () => {
  it('surfaces an internal error when a confirmed call yields another plan', async () => {
    // A hand-rolled executor that (impossibly, per the core contract) returns
    // a PLAN even when called with a confirmation token.
    const planOutcome = {
      type: 'PLAN' as const,
      plan: {
        tool: 'snap_create',
        args: {},
        systems: ['a'],
        steps: [{ system: 'a', status: 'SUCCESS' as const, value: [] }],
      },
      key: 'key',
      message: 'plan',
    };
    const executor = { execute: vi.fn().mockResolvedValue(planOutcome) } as unknown as ToolExecutor;
    const server = createServer({
      catalog: new ToolCatalog(),
      executor,
      confirmations: new ConfirmationService(),
    });
    const client = new Client(
      { name: 'test-client', version: '0.0.0' },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'accept' }));
    await connectPair(server, client);

    const result = await client.callTool({ name: 'snap_create', arguments: {} });
    expect((result as CallToolResult).isError).toBe(true);
    expect(text(result)).toContain('confirmed call returned another plan');
  });

  it('stringifies a non-Error throw into the error result', async () => {
    const executor = {
      execute: vi.fn().mockRejectedValue('exploded without an Error'),
    } as unknown as ToolExecutor;
    const server = createServer({
      catalog: new ToolCatalog(),
      executor,
      confirmations: new ConfirmationService(),
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' }, {});
    await connectPair(server, client);

    const result = await client.callTool({ name: 'anything', arguments: {} });
    expect((result as CallToolResult).isError).toBe(true);
    expect(text(result)).toBe('exploded without an Error');
  });
});

describe('ElicitationGate', () => {
  it('fails closed when elicitInput rejects with a non-Error', async () => {
    // Over a real transport the SDK wraps every failure in McpError, so a
    // non-Error rejection can only be exercised at the Server seam directly.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const confirmations = new ConfirmationService();
      const mintSpy = vi.spyOn(confirmations, 'mint');
      const gate = new ElicitationGate(
        { elicitInput: () => Promise.reject('transport torn down') } as unknown as Server,
        confirmations,
      );
      const token = await gate.requestApproval(
        { tool: 'snap_create', args: {}, systems: ['a'], steps: [] },
        'key',
      );
      expect(token).toBeNull();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('transport torn down'));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('tools/call — mutating, fallback path (opted in with requireElicitation: false)', () => {
  // The basic plan-then-confirm round-trip is the {no-elicitation × false}
  // matrix cell above; these cover the fallback path's details.
  it('partial planning failure: instructs narrowing systems, and the narrowed confirm works', async () => {
    const { client, executeSpy } = await setup({ planFailsOn: ['b'], requireElicitation: false });
    const planResult = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    const body = text(planResult);
    // The core's plan message tells the LLM exactly which systems the token
    // covers; following it must succeed.
    expect(body).toContain('Planning failed on b');
    expect(body).toContain('"systems" to exactly [a]');
    const token = /Confirmation token \(single-use, expires\): (\S+)/.exec(body)?.[1];

    const confirmed = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: ['a'], confirmation_token: token },
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(parseResults(text(confirmed))).toEqual([
      { system: 'a', status: 'SUCCESS', value: { created: 'a-snap' } },
    ]);
  });

  it('never writes reserved arguments (confirmation_token, systems) into audit events', async () => {
    const { client, auditEvents } = await setup({ requireElicitation: false });
    const planResult = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    const token = /Confirmation token \(single-use, expires\): (\S+)/.exec(text(planResult))?.[1];
    await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all', confirmation_token: token },
    });
    expect(auditEvents.map((event) => event.phase)).toEqual(['plan', 'execute']);
    for (const event of auditEvents) {
      expect(event.args).not.toHaveProperty('confirmation_token');
      expect(event.args).not.toHaveProperty('systems');
    }
  });

  it('rejects a confirmed call whose arguments drifted from the plan', async () => {
    const { client, executeSpy } = await setup({ requireElicitation: false });
    const planResult = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    const token = /Confirmation token \(single-use, expires\): (\S+)/.exec(text(planResult))?.[1];

    const drifted = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/OTHER', systems: 'all', confirmation_token: token },
    });
    expect((drifted as CallToolResult).isError).toBe(true);
    expect(text(drifted)).toMatch(/token does not match/);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
