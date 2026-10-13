import { describe, expect, it } from 'vitest';
import { assessPlanRender, firstUnexpectedName } from './plan-render';

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

describe('assessPlanRender', () => {
  it('passes when the screen contains the snapshot id, the tool and every target', () => {
    expect(
      assessPlanRender({
        seen: VERBATIM,
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
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
      }),
    ).toEqual({ ok: false, reason: `never rendered: ${SNAPSHOT}` });
  });

  it('accepts a collapsed elicitation when the plan message still names the snapshot and the targets', () => {
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
      }),
    ).toEqual({ ok: true, reason: '' });
  });

  it('does not treat a collapse trailer without the elicitation choice as the plan', () => {
    const seen = 'Tool: snapshots_create\n… (+10 more lines)';
    expect(
      assessPlanRender({
        seen,
        planMessage: PLAN,
        snapshotId: SNAPSHOT,
        targets: ['nas-a'],
      }),
    ).toEqual({ ok: false, reason: `never rendered: ${SNAPSHOT}` });
  });

  it('fails a collapsed dialog whose elicitation does not carry the snapshot id', () => {
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        planMessage: 'Tool: snapshots_create\nTarget systems: nas-a, nas-b',
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
      }),
    ).toEqual({ ok: false, reason: `collapsed plan elicitation missing: ${SNAPSHOT}` });
  });

  it('fails a collapsed dialog whose elicitation omits a target', () => {
    expect(
      assessPlanRender({
        seen: COLLAPSED_SCREEN,
        planMessage: `Tool: snapshots_create\nArguments: {"name":"${SNAPSHOT}"}\nTarget systems: nas-a`,
        snapshotId: SNAPSHOT,
        targets: ['nas-a', 'nas-b'],
      }),
    ).toEqual({ ok: false, reason: 'collapsed plan elicitation missing: nas-b' });
  });

  it('keeps the verbatim path when the accumulated screen also saw a collapse trailer', () => {
    expect(
      assessPlanRender({
        seen: `${COLLAPSED_SCREEN}\n${VERBATIM}`,
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
