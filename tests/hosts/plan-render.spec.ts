import { describe, expect, it } from 'vitest';
import { assessPlanRender, firstUnexpectedName, snapshotCallFromTrace } from './plan-render';

const SNAPSHOT = 'tank/data@probe2';
const PLAN = [
  'TrueNAS MCP wants to run a mutating operation:',
  '',
  'Tool: snapshots_create',
  `Arguments: ${JSON.stringify({ dataset: 'tank/data', name: 'probe2' })}`,
  'Target systems: nas-a, nas-b',
  '',
  'API calls to be made:',
  `- [nas-a] Create snapshot "${SNAPSHOT}"`,
  `- [nas-b] Create snapshot "${SNAPSHOT}"`,
].join('\n');

const VERBATIM = `${PLAN}\nAccept to execute exactly these calls, or decline to cancel.`;

/** The screen Claude Code 2.1.296 actually left up: the tool line, a collapsed
 * body, and the accept/decline choice. The snapshot id is not in it. */
const COLLAPSED_SCREEN = [
  'Call snapshots_create with dataset "tank/data", name "probe2", systems "all".',
  'Tool: snapshots_create',
  '… (+10 more lines)',
  '❯ Accept    Decline',
  'Esc to cancel',
].join('\n');

const CALL = { dataset: 'tank/data', name: 'probe2' };

function toolsCall(args: Record<string, unknown>): {
  dir: string;
  message: { method: string; params: Record<string, unknown> };
} {
  return {
    dir: 'recv',
    message: {
      method: 'tools/call',
      params: { name: 'snapshots_create', arguments: args },
    },
  };
}

describe('snapshotCallFromTrace', () => {
  it('reads dataset and name, and keeps a systems list', () => {
    expect(
      snapshotCallFromTrace([
        toolsCall({ dataset: 'tank/data', name: 'probe2', systems: ['nas-a'] }),
      ]),
    ).toEqual({ dataset: 'tank/data', name: 'probe2', systems: ['nas-a'] });
  });

  it('treats a single registry name as the target list', () => {
    expect(
      snapshotCallFromTrace([toolsCall({ dataset: 'tank/data', name: 'probe2', systems: 'nas-a' })]),
    ).toEqual({ dataset: 'tank/data', name: 'probe2', systems: ['nas-a'] });
  });

  it('does not treat systems "all" as a list of targets', () => {
    expect(
      snapshotCallFromTrace([toolsCall({ dataset: 'tank/data', name: 'probe2', systems: 'all' })]),
    ).toEqual(CALL);
  });

  it('keeps the last snapshots_create call before the elicitation', () => {
    expect(
      snapshotCallFromTrace([
        toolsCall({ dataset: 'tank/data', name: 'earlier', systems: 'all' }),
        toolsCall({ dataset: 'tank/data', name: 'probe2', systems: 'all' }),
        { dir: 'send', message: { method: 'elicitation/create', params: {} } },
        toolsCall({ dataset: 'tank/data', name: 'later', systems: 'all' }),
      ]),
    ).toEqual(CALL);
  });

  it('returns undefined when dataset is not a string', () => {
    expect(snapshotCallFromTrace([toolsCall({ dataset: 1, name: 'probe2' })])).toBeUndefined();
  });

  it('returns undefined when a systems list contains a non-string', () => {
    expect(
      snapshotCallFromTrace([
        toolsCall({ dataset: 'tank/data', name: 'probe2', systems: ['nas-a', 1] }),
      ]),
    ).toBeUndefined();
  });
});

describe('assessPlanRender', () => {
  it('passes when the screen contains the snapshot id, the tool and every target', () => {
    expect(
      assessPlanRender({
        seen: VERBATIM,
        screen: '',
        planMessage: '',
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
      }),
    ).toEqual({ ok: true, reason: '' });
  });

  it('fails a screen that never shows the snapshot id and does not collapse the plan', () => {
    const seen = 'Call snapshots_create with dataset "tank/data", name "probe2".';
    expect(
      assessPlanRender({
        seen,
        screen: seen,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
        call: CALL,
      }),
    ).toEqual({ ok: false, reason: `never rendered: ${SNAPSHOT}` });
  });

  it('accepts a collapsed frame when the tools/call and the API-calls lines agree', () => {
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        screen: COLLAPSED_SCREEN,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
        call: CALL,
      }),
    ).toEqual({ ok: true, reason: '' });
  });

  it('does not treat a collapse trailer without the elicitation choice as the plan', () => {
    const screen = 'Tool: snapshots_create\n… (+10 more lines)';
    expect(
      assessPlanRender({
        seen: screen,
        screen,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a'],
        call: { ...CALL, systems: ['nas-a'] },
      }),
    ).toEqual({ ok: false, reason: `never rendered: ${SNAPSHOT}` });
  });

  it('does not assemble the collapse from markers on earlier frames', () => {
    const seen = ['Tool: snapshots_create', '… (+10 more lines)', 'Accept', 'Decline', 'later'].join(
      '\n',
    );
    expect(
      assessPlanRender({
        seen,
        screen: 'later frame with no plan',
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
        call: CALL,
      }),
    ).toEqual({ ok: false, reason: `never rendered: ${SNAPSHOT}` });
  });

  it('rejects a tools/call snapshot that is not the id extracted from the elicitation', () => {
    // driveToPlan takes the id and the targets from this message, and both
    // are substrings of it. A check that only asks the message whether it
    // contains them passes. The tools/call arguments do not.
    expect(PLAN).toContain(SNAPSHOT);
    expect(PLAN).toContain('Target systems: nas-a, nas-b');
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        screen: COLLAPSED_SCREEN,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
        call: { dataset: 'tank/data', name: 'other' },
      }),
    ).toEqual({
      ok: false,
      reason: 'collapsed plan tools/call snapshot is tank/data@other, not tank/data@probe2',
    });
  });

  it('rejects a target that appears only on the Target systems line', () => {
    const planMessage = [
      'Tool: snapshots_create',
      'Target systems: nas-a, nas-b',
      '',
      'API calls to be made:',
      `- [nas-a] Create snapshot "${SNAPSHOT}"`,
    ].join('\n');
    expect(planMessage).toContain('nas-b');
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        screen: COLLAPSED_SCREEN,
        planMessage,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
        call: CALL,
      }),
    ).toEqual({ ok: false, reason: 'collapsed plan API calls missing: nas-b' });
  });

  it('rejects a tools/call systems list that is not the extracted targets', () => {
    expect(PLAN).toContain('- [nas-a]');
    expect(PLAN).toContain('- [nas-b]');
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        screen: COLLAPSED_SCREEN,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
        call: { dataset: 'tank/data', name: 'probe2', systems: ['nas-a'] },
      }),
    ).toEqual({
      ok: false,
      reason: 'collapsed plan tools/call systems are nas-a, not nas-a, nas-b',
    });
  });

  it('rejects a collapsed frame when the trace has no snapshots_create arguments', () => {
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        screen: COLLAPSED_SCREEN,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
      }),
    ).toEqual({ ok: false, reason: 'collapsed plan tools/call arguments are missing' });
  });

  it('rejects a collapsed frame whose elicitation has no API calls section', () => {
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        screen: COLLAPSED_SCREEN,
        planMessage: `Tool: snapshots_create\nTarget systems: nas-a, nas-b\n"${SNAPSHOT}"`,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
        call: CALL,
      }),
    ).toEqual({ ok: false, reason: 'collapsed plan elicitation has no API calls section' });
  });

  it('keeps the verbatim path when the accumulated screen also saw a collapse trailer', () => {
    expect(
      assessPlanRender({
        seen: `${COLLAPSED_SCREEN}\n${VERBATIM}`,
        screen: 'a later frame that is not the dialog',
        planMessage: '',
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
      }),
    ).toEqual({ ok: true, reason: '' });
  });
});

describe('firstUnexpectedName', () => {
  it('returns null when the name is in neither place', () => {
    expect(firstUnexpectedName('Tool: snapshots_create', PLAN, ['nas-c'])).toBeNull();
  });

  it('returns a name that reached the screen', () => {
    expect(firstUnexpectedName('plan covers nas-b', 'Target systems: nas-a', ['nas-b'])).toBe(
      'nas-b',
    );
  });

  it('returns a name the collapse hid but the elicitation still names', () => {
    expect(firstUnexpectedName(COLLAPSED_SCREEN, PLAN, ['nas-b'])).toBe('nas-b');
  });

  it('returns null for an empty list', () => {
    expect(firstUnexpectedName(COLLAPSED_SCREEN, PLAN, [])).toBeNull();
  });
});
