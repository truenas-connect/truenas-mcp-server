/**
 * Whether an interactive host has shown the approval plan.
 *
 * Goose prints the elicitation verbatim, so the snapshot id, the tool name
 * and every target have to appear in the accumulated terminal text. Claude
 * Code 2.1.296 paints `Tool: snapshots_create` and then collapses the rest
 * of the body to `(+N more lines)` (nightly run 38461826132). Those hidden
 * lines are where the snapshot id and, on a fan-out, the system names live.
 * Ctrl+O would open transcript mode, and the next Esc — Claude's decline
 * key — would leave that mode instead of declining, so the test does not
 * send it.
 *
 * A collapse is accepted only when one screen frame shows all of
 * `Tool: snapshots_create`, the `(+N more lines)` trailer, and Accept and
 * Decline. Markers gathered from earlier polls do not count. The hidden
 * strings are not re-checked as substrings of the elicitation: the snapshot
 * id and the targets are parsed out of that message, so asking the message
 * whether it contains them cannot fail. What is checked instead:
 *
 * - the snapshot id equals `${dataset}@${name}` from the `snapshots_create`
 *   arguments on the `tools/call` frame that preceded the elicitation;
 * - when that call's `systems` argument is a registry name or a list of
 *   names, it is the same set as the targets. `"all"`, and an omitted
 *   `systems`, do not name them and are not compared;
 * - each target appears as `- [name]` in the message's `API calls to be
 *   made:` section. A name that appears only on the `Target systems:` line
 *   does not count.
 *
 * A frame with no trailer still fails.
 */

export const COLLAPSED_PLAN = /\(\+\d+ more lines\)/;

const TOOL = 'snapshots_create';
const API_CALLS = 'API calls to be made:';

/** `snapshots_create` arguments from the tools/call that the elicitation gates. */
export interface SnapshotCall {
  dataset: string;
  name: string;
  /**
   * Set when `systems` is a registry name or a list of names. Omitted for
   * `"all"`, which does not name the targets.
   */
  systems?: readonly string[];
}

export interface CallFrame {
  dir: string;
  message: {
    method?: string;
    params?: Record<string, unknown>;
  };
}

export interface PlanRenderInput {
  /** Every screen poll so far. A scrolled plan still counts as shown. */
  seen: string;
  /** The current screen only. The collapse markers are read from this. */
  screen: string;
  planMessage: string;
  snapshotId: string;
  targets: readonly string[];
  call?: SnapshotCall;
}

export interface PlanRenderAssessment {
  ok: boolean;
  /** Empty when ok. The interactive spec uses it as the assertion message. */
  reason: string;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((name, index) => name === b[index]);
}

/**
 * `undefined` when `systems` does not name targets (`"all"`, or omitted).
 * `null` when the value is present and is not a name or a list of names, so
 * the call is unreadable rather than treated as having no target list.
 */
function namedSystems(systems: unknown): readonly string[] | undefined | null {
  if (systems === undefined || systems === 'all') {
    return undefined;
  }
  if (typeof systems === 'string') {
    return [systems];
  }
  if (Array.isArray(systems) && systems.every((entry) => typeof entry === 'string')) {
    return systems as string[];
  }
  return null;
}

function parseSnapshotCall(params: Record<string, unknown> | undefined): SnapshotCall | undefined {
  if (params?.['name'] !== TOOL) {
    return undefined;
  }
  const args = params['arguments'];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const dataset = record['dataset'];
  const name = record['name'];
  if (typeof dataset !== 'string' || typeof name !== 'string') {
    return undefined;
  }
  const systems = namedSystems(record['systems']);
  if (systems === null) {
    return undefined;
  }
  return systems === undefined ? { dataset, name } : { dataset, name, systems };
}

/**
 * The last `snapshots_create` tools/call before the elicitation. A call that
 * arrives after the plan was sent did not produce this elicitation.
 */
export function snapshotCallFromTrace(frames: readonly CallFrame[]): SnapshotCall | undefined {
  let found: SnapshotCall | undefined;
  for (const frame of frames) {
    if (frame.message.method === 'elicitation/create') {
      break;
    }
    if (frame.dir !== 'recv' || frame.message.method !== 'tools/call') {
      continue;
    }
    const parsed = parseSnapshotCall(frame.message.params);
    if (parsed) {
      found = parsed;
    }
  }
  return found;
}

function apiCallsBody(planMessage: string): string | undefined {
  const at = planMessage.indexOf(API_CALLS);
  if (at === -1) {
    return undefined;
  }
  return planMessage.slice(at + API_CALLS.length);
}

function collapsedOnThisFrame(screen: string): boolean {
  return (
    screen.includes(`Tool: ${TOOL}`) &&
    COLLAPSED_PLAN.test(screen) &&
    screen.includes('Accept') &&
    screen.includes('Decline')
  );
}

export function assessPlanRender(input: PlanRenderInput): PlanRenderAssessment {
  const required = [input.snapshotId, TOOL, ...input.targets];
  const missingOnScreen = required.filter((needle) => !input.seen.includes(needle));
  if (missingOnScreen.length === 0) {
    return { ok: true, reason: '' };
  }

  if (!collapsedOnThisFrame(input.screen)) {
    return { ok: false, reason: `never rendered: ${missingOnScreen[0]}` };
  }

  if (!input.call) {
    return { ok: false, reason: 'collapsed plan tools/call arguments are missing' };
  }
  const composed = `${input.call.dataset}@${input.call.name}`;
  if (composed !== input.snapshotId) {
    return {
      ok: false,
      reason: `collapsed plan tools/call snapshot is ${composed}, not ${input.snapshotId}`,
    };
  }
  if (input.call.systems !== undefined && !sameNames(input.call.systems, input.targets)) {
    return {
      ok: false,
      reason:
        `collapsed plan tools/call systems are ${input.call.systems.join(', ')}, ` +
        `not ${input.targets.join(', ')}`,
    };
  }

  const apiCalls = apiCallsBody(input.planMessage);
  if (apiCalls === undefined) {
    return { ok: false, reason: 'collapsed plan elicitation has no API calls section' };
  }
  const missingTarget = input.targets.find((target) => !apiCalls.includes(`- [${target}]`));
  if (missingTarget !== undefined) {
    return { ok: false, reason: `collapsed plan API calls missing: ${missingTarget}` };
  }
  return { ok: true, reason: '' };
}

/**
 * The first name present on the screen or in the elicitation, or null.
 * Screen-only is not enough once a host collapses the plan body: a name
 * inside `(+N more lines)` never reaches the buffer, so an untargeted system
 * the plan still binds would pass a screen check.
 */
export function firstUnexpectedName(
  seen: string,
  planMessage: string,
  names: readonly string[],
): string | null {
  return names.find((name) => seen.includes(name) || planMessage.includes(name)) ?? null;
}
