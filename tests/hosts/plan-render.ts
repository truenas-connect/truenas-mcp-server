/**
 * Whether an interactive host has shown the approval plan.
 *
 * Goose prints the elicitation verbatim, so the snapshot id, the tool name
 * and every target have to appear in the terminal text. Claude Code 2.1.296
 * paints `Tool: snapshots_create` and then collapses the rest of the body to
 * `(+N more lines)` (nightly run 38461826132). Those hidden lines are where
 * the snapshot id and, on a fan-out, the system names live. Ctrl+O would open
 * transcript mode, and the next Esc — Claude's decline key — would leave
 * that mode instead of declining, so the test does not send it.
 *
 * A collapse is accepted only when the screen is the elicitation dialog
 * (`Tool: snapshots_create`, the collapse trailer, and the Accept/Decline
 * choice) and the elicitation message itself still carries every string the
 * collapse hid. A host that truncates without that trailer still fails.
 */

export const COLLAPSED_PLAN = /\(\+\d+ more lines\)/;

const TOOL = 'snapshots_create';

export interface PlanRenderInput {
  seen: string;
  planMessage: string;
  snapshotId: string;
  targets: readonly string[];
}

export interface PlanRenderAssessment {
  ok: boolean;
  /** Empty when ok. The interactive spec uses it as the assertion message. */
  reason: string;
}

export function assessPlanRender(input: PlanRenderInput): PlanRenderAssessment {
  const required = [input.snapshotId, TOOL, ...input.targets];
  const missingOnScreen = required.filter((needle) => !input.seen.includes(needle));
  if (missingOnScreen.length === 0) {
    return { ok: true, reason: '' };
  }

  const collapsed =
    input.seen.includes(`Tool: ${TOOL}`) &&
    COLLAPSED_PLAN.test(input.seen) &&
    input.seen.includes('Accept') &&
    input.seen.includes('Decline');
  if (!collapsed) {
    return { ok: false, reason: `never rendered: ${missingOnScreen[0]}` };
  }

  const missingInPlan = required.filter((needle) => !input.planMessage.includes(needle));
  if (missingInPlan.length > 0) {
    return { ok: false, reason: `collapsed plan elicitation missing: ${missingInPlan[0]}` };
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
