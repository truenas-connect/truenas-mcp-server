import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { TrueNasApiClient } from '@truenas/api-client';
import {
  ConfirmationService,
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
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '@/server';

interface SetupOptions {
  /** Undefined → client without elicitation capability (the fallback path). */
  onElicit?: (message: string) => ElicitResult | Promise<ElicitResult>;
  /** System names whose plan phase fails. */
  planFailsOn?: string[];
  elicitationTimeoutMs?: number;
  requireElicitation?: boolean;
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
    handler: ({ system }) => Promise.resolve(`${system.name}-healthy`),
  };

  const catalog = new ToolCatalog();
  catalog.register(mutatingTool);
  catalog.register(readTool);
  const confirmations = new ConfirmationService();
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

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, executeSpy, elicitations, auditEvents };
}

function text(result: unknown): string {
  const content = (result as CallToolResult).content;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return (content[0] as { type: 'text'; text: string }).text;
}

function parseResults(body: string): SystemResult<unknown>[] {
  // Results are the JSON block; anything before it is a human-facing prefix.
  return JSON.parse(body.slice(body.indexOf('['))) as SystemResult<unknown>[];
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
});

describe('tools/call — mutating, elicitation path', () => {
  it('executes after the user accepts, within one call', async () => {
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

describe('tools/call — requireElicitation', () => {
  it('refuses mutating calls from a client without elicitation, minting no token', async () => {
    const { client, executeSpy, auditEvents } = await setup({ requireElicitation: true });
    const result = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    expect((result as CallToolResult).isError).toBe(true);
    const body = text(result);
    expect(body).toContain('does not support elicitation');
    expect(body).not.toContain('Confirmation token');
    expect(executeSpy).not.toHaveBeenCalled();
    // The refusal happens after planning (that is how mutating calls are
    // detected), but nothing must reach the execute phase.
    expect(auditEvents.map((event) => event.phase)).toEqual(['plan']);
  });

  it('leaves read-only calls untouched for a client without elicitation', async () => {
    const { client } = await setup({ requireElicitation: true });
    const result = await client.callTool({ name: 'pool_status', arguments: { systems: 'all' } });
    expect((result as CallToolResult).isError).toBeUndefined();
    expect(parseResults(text(result))).toHaveLength(2);
  });

  it('leaves the elicitation path untouched', async () => {
    const { client, executeSpy } = await setup({
      requireElicitation: true,
      onElicit: () => ({ action: 'accept' }),
    });
    const result = await client.callTool({
      name: 'snap_create',
      arguments: { dataset: 'tank/x', systems: 'all' },
    });
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect((result as CallToolResult).isError).toBeUndefined();
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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'snap_create', arguments: {} });
    expect((result as CallToolResult).isError).toBe(true);
    expect(text(result)).toContain('confirmed call returned another plan');
  });
});

describe('tools/call — mutating, fallback path (no elicitation)', () => {
  it('returns the plan and a token, then executes on the confirmed call', async () => {
    const { client, executeSpy } = await setup();
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

  it('partial planning failure: instructs narrowing systems, and the narrowed confirm works', async () => {
    const { client, executeSpy } = await setup({ planFailsOn: ['b'] });
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
    const { client, auditEvents } = await setup();
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
    const { client, executeSpy } = await setup();
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
