import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConfirmationGate, ConfirmationService, Plan } from '@truenas/mcp-base';

/** Human-readable rendering of a plan: what would run, where, exactly. */
export function renderPlan(plan: Plan): string {
  const lines: string[] = [
    `Tool: ${plan.tool}`,
    `Arguments: ${JSON.stringify(plan.args)}`,
    `Target systems: ${plan.systems.join(', ')}`,
    '',
    'API calls to be made:',
  ];
  for (const step of plan.steps) {
    if (step.status === 'SUCCESS') {
      for (const call of step.value) {
        lines.push(`- [${step.system}] ${call.description}`);
        lines.push(`    ${call.method} ${JSON.stringify(call.params)}`);
      }
    } else {
      lines.push(
        `- [${step.system}] planning failed: ${step.error.message} — this system will be skipped`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * The head of the elicitation message: what will change and where, in two
 * lines. Hosts clamp the message they show a human — Claude Code 2.1.268
 * renders three lines of it and folds the rest behind "… (+N more lines)"
 * with no key that expands it (observed 2026-09-11 on the tier-3 fixture;
 * the same host rendered the whole plan in August). So everything a person
 * must read before approving goes here, ahead of the full rendering that
 * hosts with room show in its entirety.
 *
 * Line one names the tool and the systems it will run on. Line two is what
 * each call does, in the words the plan step gave it: one line when every
 * system gets the same calls, otherwise one entry per system — and a system
 * whose planning failed says so, because the plan skips it and the human is
 * approving that skip too.
 */
export function summarizePlan(plan: Plan): string {
  const perSystem = plan.steps.map((step) =>
    step.status === 'SUCCESS'
      ? step.value.map((call) => call.description).join('; ')
      : `planning failed (${step.error.message}), skipped`,
  );
  const uniform = perSystem.length > 0 && perSystem.every((entry) => entry === perSystem[0]);
  const what = uniform
    ? perSystem[0]
    : plan.steps.map((step, i) => `${step.system}: ${perSystem[i]}`).join(' | ');
  return `TrueNAS MCP: run ${plan.tool} on ${plan.systems.join(', ')}?\n${what}`;
}

/** The whole elicitation message: the head a clamped host still shows, then
 * the full plan, then what accept and decline mean. */
export function renderElicitationMessage(plan: Plan): string {
  return (
    `${summarizePlan(plan)}\n\n${renderPlan(plan)}\n\n` +
    'Accept to execute exactly these calls, or decline to cancel.'
  );
}

/**
 * Confirmation gate over MCP elicitation: the host prompts the user with the
 * plan; only an explicit accept mints a token (ER-172 A2.3). This is the only
 * call site of {@link ConfirmationService.mint} on the elicitation path, per
 * the core's adapter contract.
 */
export class ElicitationGate implements ConfirmationGate {
  constructor(
    private readonly server: Server,
    private readonly confirmations: ConfirmationService,
    /**
     * Cap on waiting for the user's answer; aligned with the confirmation
     * token TTL rather than the SDK's 60s request default — a human reading a
     * multi-system plan can legitimately take minutes.
     */
    private readonly timeoutMs: number = 5 * 60 * 1000,
  ) {}

  async requestApproval(plan: Plan, key: string): Promise<string | null> {
    let result: ElicitResult;
    try {
      result = await this.server.elicitInput(
        {
          message: renderElicitationMessage(plan),
          // No form fields: accept/decline itself is the answer. Compatibility
          // note: message-only elicitation with an empty properties object is
          // handled by the reference SDK and Inspector, but not guaranteed
          // uniform across MCP clients — a client that chokes on it surfaces
          // as an error below, which fails closed (not approved).
          requestedSchema: { type: 'object', properties: {} },
        },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      // Timeout, cancellation, or a client that claims the capability but
      // errors — all fail closed as "not approved".
      console.error(
        `Elicitation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (result.action !== 'accept') {
      return null;
    }
    return this.confirmations.mint(key);
  }
}
