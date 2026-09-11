import type { Plan } from '@truenas/mcp-base';
import { describe, expect, it } from 'vitest';
import { renderElicitationMessage, renderPlan, summarizePlan } from '@/gate';

const call = (dataset: string, name: string) => ({
  method: 'pool.snapshot.create',
  params: [{ dataset, name, recursive: false }],
  description: `Create snapshot "${dataset}@${name}"`,
});

const fanOut: Plan = {
  tool: 'snapshots_create',
  args: { dataset: 'tank/data', name: 'probe', systems: 'all' },
  systems: ['nas-a', 'nas-b'],
  steps: [
    { system: 'nas-a', status: 'SUCCESS', value: [call('tank/data', 'probe')] },
    { system: 'nas-b', status: 'SUCCESS', value: [call('tank/data', 'probe')] },
  ],
};

/**
 * What these prove: the facts a human must read before approving survive a
 * host that shows only the first lines of the message. Claude Code 2.1.268
 * renders three lines of an elicitation message and folds the rest with no
 * way to expand, so the tool, the target systems and what each call does
 * have to sit in the first two lines — the tier-3 suite asserts they reach
 * the screen, and this is the contract that makes that possible.
 */
describe('summarizePlan', () => {
  it('puts the tool and every target system on line one, and what changes on line two', () => {
    const [where, what, ...rest] = summarizePlan(fanOut).split('\n');
    expect(where).toBe('TrueNAS MCP: run snapshots_create on nas-a, nas-b?');
    expect(what).toBe('Create snapshot "tank/data@probe"');
    expect(rest).toEqual([]);
  });

  it('lists per system when the systems get different calls', () => {
    const plan: Plan = {
      ...fanOut,
      steps: [
        { system: 'nas-a', status: 'SUCCESS', value: [call('tank/data', 'probe')] },
        { system: 'nas-b', status: 'SUCCESS', value: [call('tank/other', 'probe')] },
      ],
    };
    expect(summarizePlan(plan).split('\n')[1]).toBe(
      'nas-a: Create snapshot "tank/data@probe" | nas-b: Create snapshot "tank/other@probe"',
    );
  });

  it('says a system whose planning failed is skipped, so the human approves the skip knowingly', () => {
    const plan: Plan = {
      ...fanOut,
      steps: [
        { system: 'nas-a', status: 'SUCCESS', value: [call('tank/data', 'probe')] },
        {
          system: 'nas-b',
          status: 'ERROR',
          error: { message: 'pool.query denied', errname: null, errno: null },
        },
      ],
    };
    expect(summarizePlan(plan).split('\n')[1]).toBe(
      'nas-a: Create snapshot "tank/data@probe" | nas-b: planning failed (pool.query denied), skipped',
    );
  });
});

describe('renderElicitationMessage', () => {
  it('leads with the summary, then carries the full plan and what accept means', () => {
    const message = renderElicitationMessage(fanOut);
    expect(message.startsWith(`${summarizePlan(fanOut)}\n\n`)).toBe(true);
    expect(message).toContain(renderPlan(fanOut));
    expect(message.endsWith('Accept to execute exactly these calls, or decline to cancel.')).toBe(true);
  });

  it('keeps the snapshot id and every target within the first two lines', () => {
    const head = renderElicitationMessage(fanOut).split('\n').slice(0, 2).join('\n');
    expect(head).toContain('tank/data@probe');
    expect(head).toContain('nas-a');
    expect(head).toContain('nas-b');
  });
});
