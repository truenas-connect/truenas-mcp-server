import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Role,
  type AdvertisedTool,
  type ConfirmationService,
  type ExecutionOutcome,
  type ToolCatalog,
  type ToolExecutor,
} from '@truenas/mcp-base';
import { ElicitationGate, renderPlan } from '@/gate';
import { VERSION } from '@/version';

export interface ServerDeps {
  catalog: ToolCatalog;
  executor: ToolExecutor;
  confirmations: ConfirmationService;
  /** Cap on waiting for an elicitation answer; default 5 minutes (token TTL). */
  elicitationTimeoutMs?: number;
  /**
   * Refuse mutating calls from clients without elicitation instead of using
   * the plan+token fallback. Defaults to true — set it to false explicitly to
   * opt back into the fallback.
   */
  requireElicitation?: boolean;
}

type PlanOutcome = Extract<ExecutionOutcome, { type: 'PLAN' }>;
type ResultsOutcome = Extract<ExecutionOutcome, { type: 'RESULTS' }>;

function toMcpTool(tool: AdvertisedTool): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as McpTool['inputSchema'],
    annotations: {
      readOnlyHint: !tool.mutating,
      // Reversible is not the same as non-destructive: hosts use this hint to
      // calibrate their native confirmation prompt — the fallback path's human
      // gate — so every mutating tool advertises destructive.
      destructiveHint: tool.mutating,
    },
  };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Renders a RESULTS outcome: an optional human-facing prefix, the per-system
 * results as a JSON block, and — when the core attached it — the tool's
 * result guidance after the data it is about.
 *
 * The guidance is the interpretation half of a tool's description (null /
 * empty / unreadable conventions, what a field does not establish), which the
 * core delivers with the first data-bearing result per tool per session
 * instead of advertising it in every `tools/list`. Rendering it here is what
 * lets the core stop carrying that text in `description`, so the field must
 * never be dropped: its absence on a later call means "already delivered",
 * and a caller that never saw it would be left without the caveats.
 */
function resultsText(outcome: ResultsOutcome, prefix?: string): string {
  const body = JSON.stringify(outcome.results, null, 2);
  const data = prefix ? `${prefix}\n${body}` : body;
  if (outcome.guidance === undefined) {
    return data;
  }
  return (
    `${data}\n\n` +
    `How to read ${outcome.tool} results (sent once per session, keep it in mind ` +
    `for later calls):\n${outcome.guidance}`
  );
}

/**
 * Wires the core to a stdio-hosted MCP server. Two confirmation paths for
 * mutating tools (A2.3):
 *
 * - Client supports elicitation → the plan is approved by the user in the host
 *   UI within the same tool call; the token never enters the LLM's context.
 * - Otherwise → refused. The fallback below is weaker than it looks, so it is
 *   off unless asked for: `requireElicitation` defaults to true and only an
 *   explicit `false` re-enables it. Read-only calls are unaffected either way.
 * - Fallback, opted into with `requireElicitation: false` → the plan and a
 *   token are returned to the LLM with instructions to re-call only after the
 *   user approves in chat. The token is minted before any approval, so it
 *   binds the plan but does not gate it; the host's native per-tool-call
 *   permission prompt is the actual human gate (documented in README).
 */
export function createServer({
  catalog,
  executor,
  confirmations,
  elicitationTimeoutMs,
  requireElicitation,
}: ServerDeps): Server {
  const server = new Server(
    { name: 'truenas-mcp-server', version: VERSION },
    { capabilities: { tools: {} } },
  );
  const gate = new ElicitationGate(server, confirmations, elicitationTimeoutMs);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // Role mapping is the core's always-Full stub for now (proposal open
    // question 4); once real, this becomes the effective role per credential.
    tools: catalog.list(Role.Full).map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const outcome = await executor.execute(name, args);
      if (outcome.type === 'RESULTS') {
        return textResult(resultsText(outcome));
      }
      if (server.getClientCapabilities()?.elicitation) {
        return await approveAndExecute(outcome);
      }
      // Default-deny: only an explicit `false` opts into the weaker fallback.
      if (requireElicitation !== false) {
        return textResult(
          `Mutating tools are disabled for this client: it does not support elicitation, so ` +
            `no plan could be approved by the user in the host UI. Nothing was executed. ` +
            `Read-only tools remain available. To run mutating tools, connect with an ` +
            `elicitation-capable MCP host, or set "requireElicitation": false in the server ` +
            `config to allow the weaker in-chat approval flow.`,
          true,
        );
      }
      const token = confirmations.mint(outcome.key);
      return textResult(
        `${outcome.message}\n\n${renderPlan(outcome.plan)}\n\n` +
          `Confirmation token (single-use, expires): ${token}\n` +
          'Present this plan to the user verbatim, and call the tool again with ' +
          'confirmation_token ONLY after they explicitly approve.\n' +
          '(Operator note: this client does not support elicitation, so the ' +
          'human gate is your host prompting per tool call — if tool calls are ' +
          'auto-approved, the in-chat approval above is the only safeguard.)',
      );
    } catch (error) {
      // Normalized, LLM-interpretable errors (V5.3): unknown tool, bad
      // selector, role denial, rejected confirmation token. Forwarded
      // verbatim on the assumption that core/api-client messages never embed
      // credentials — API keys live only in config and are never accepted as
      // tool arguments.
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  async function approveAndExecute(outcome: PlanOutcome): Promise<CallToolResult> {
    const token = await gate.requestApproval(outcome.plan, outcome.key);
    if (token === null) {
      return textResult('The user declined the plan (or did not respond) — nothing was executed.');
    }
    // The key (and therefore the token) binds only the successfully planned
    // systems, so the confirmed call must target exactly those. Never empty:
    // the core returns RESULTS instead of a PLAN when planning fails on every
    // system.
    //
    // Note: the confirmed call does NOT re-plan — the executor runs plan()
    // only when no token is present, and the key covers tool + args + systems
    // (never plan output). State drift between approval and execution
    // therefore surfaces as per-system execute errors, not a token mismatch.
    const planned = outcome.plan.steps
      .filter((step) => step.status === 'SUCCESS')
      .map((step) => step.system);
    const executed = await executor.execute(outcome.plan.tool, {
      ...outcome.plan.args,
      systems: planned,
      confirmation_token: token,
    });
    if (executed.type !== 'RESULTS') {
      throw new Error('Internal error: a confirmed call returned another plan');
    }
    return textResult(resultsText(executed, 'Approved by the user in the client UI.'));
  }

  return server;
}
