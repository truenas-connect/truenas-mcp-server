import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterAvailable, adapters, type HostAdapter } from './adapters';
import {
  ABSENT_SYSTEM,
  elicitationAccepts,
  elicitationAnswers,
  FIXTURE_SYSTEMS,
  hostEnv,
  readAudit,
  readTrace,
  setUpFixture,
  until,
  type FixturePaths,
} from './harness';

/**
 * Tier 3, interactive: proves the human is actually
 * SHOWN the plan. Every lower tier stops at the wire; a host could answer the
 * protocol perfectly and render nothing useful, and the gate would be
 * technically satisfied and practically defeated. The host's output goes
 * through a real PTY into a real terminal emulator, and the assertion reads
 * the screen buffer a human would see — with the expected substring taken
 * from the elicitation frame in our own trace, never hard-coded against TUI
 * chrome.
 *
 * Probe history (2026-08-07, settled 2026-08-08): this suite's originally
 * inconclusive probe died before tools/call because hosts render first-run
 * dialogs (Claude Code's trust-folder prompt, goose's telemetry consent)
 * before the input box exists — anything typed earlier lands in the dialog.
 * The driver answers an adapter's declared startupDialogs first, then waits
 * for its readyPattern before typing.
 */

const COLS = 120;
const ROWS = 40;

const FULL_PROMPT =
  'Call snapshots_create with dataset "tank/data", name "probe2", systems "all". ' +
  'Do not ask me anything first.';

/** The narrowed scenario targets one registered system by name; the rest of
 * the registry must never reach the screen. */
const NARROW_TARGET = FIXTURE_SYSTEMS[0] as string;
const NARROW_PROMPT =
  `Call snapshots_create with dataset "tank/data", name "probe3", systems ["${NARROW_TARGET}"]. ` +
  'Do not ask me anything first.';

/** A TUI session driven to the point where the server sent its elicitation:
 * the plan is extracted from our own trace, the screen is still untouched by
 * any approval. */
interface PlanSession {
  pty: IPty;
  screenText(): string;
  tracePath: string;
  auditPath: string;
  planMessage: string;
  /** From the plan's "Target systems:" line — what the plan actually binds,
   * regardless of what the model was asked to do. */
  targets: string[];
  snapshotId: string;
}

async function driveToPlan(
  adapter: HostAdapter,
  argv: string[],
  ready: RegExp,
  fixture: FixturePaths,
  dir: string,
  prompt: string,
  onSpawn: (pty: IPty) => void,
): Promise<PlanSession> {
  const { tracePath, auditPath } = fixture;
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const pty = ptySpawn(adapter.command, argv, {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: dir,
    env: { ...hostEnv(), ...adapter.env },
  });
  onSpawn(pty);
  pty.onData((data) => term.write(data));

  const screenText = (): string => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  };

  // Reach the input box, answering first-run dialogs if they appear.
  const answered = new Set<RegExp>();
  await until(() => {
    const screen = screenText();
    for (const dialog of adapter.startupDialogs ?? []) {
      if (!answered.has(dialog.pattern) && dialog.pattern.test(screen)) {
        pty.write(dialog.response);
        answered.add(dialog.pattern);
      }
    }
    return ready.test(screen);
  }, 120_000);
  expect(screenText(), 'TUI never became ready').toMatch(ready);

  // One mutating call; the brief pause keeps the Enter from being
  // treated as part of a paste.
  pty.write(prompt);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  pty.write('\r');

  // The gate fires: our server sends the elicitation. Generous budget —
  // an Ollama-backed host on CI CPU can take minutes to get here.
  await until(() => JSON.stringify(readTrace(tracePath)).includes('elicitation/create'), 780_000);
  const elicit = readTrace(tracePath).find(
    (f) => f.dir === 'send' && f.message.method === 'elicitation/create',
  );
  expect(elicit, 'server never sent elicitation/create').toBeDefined();
  const planMessage = elicit?.message.params?.['message'] as string;

  // The strings the human must see, taken from the plan we generated:
  // the snapshot id, and the systems the plan targets — read from the
  // frame, never hard-coded, so they follow the fixture at any N.
  // Deliberately not the full prose lines — the model chooses the snapshot
  // name, and pinning its exact wording would fail on a paraphrase rather
  // than on the thing under test (that the human is shown what will change).
  const snapshotId = /"([^"]+@[^"]+)"/.exec(planMessage)?.[1];
  expect(snapshotId).toMatch(/^tank\/data@/);
  const targets = /^Target systems: (.+)$/m.exec(planMessage)?.[1]?.split(', ') ?? [];

  return {
    pty,
    screenText,
    tracePath,
    auditPath,
    planMessage,
    targets,
    snapshotId: snapshotId as string,
  };
}

/** Deliberate semantics — do not "fix" this into a single-snapshot check:
 * each string must appear in the terminal text at some point before
 * approval, accumulated across polls. A fixed-size box that scrolls a long
 * plan still showed it to the human and passes; a host that truncates or
 * summarises the tail never renders the name at all and fails here. The
 * accumulated text is returned so callers can also assert absences. */
async function accumulateUntilRendered(
  screenText: () => string,
  needles: string[],
): Promise<string> {
  let seen = '';
  await until(() => {
    seen += `\n${screenText()}`;
    return needles.every((needle) => seen.includes(needle));
  }, 120_000);
  for (const needle of needles) {
    expect(seen, `never rendered: ${needle}`).toContain(needle);
  }
  return seen;
}

/** Declines the rendered elicitation; the answer must be a non-accept and
 * nothing may have executed. */
async function declineAndExpectNothingExecuted(
  session: PlanSession,
  declineKeys: string[],
): Promise<void> {
  for (const key of declineKeys) {
    session.pty.write(key);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await until(() => elicitationAnswers(readTrace(session.tracePath)).length > 0, 120_000);
  const frames = readTrace(session.tracePath);
  expect(elicitationAnswers(frames).length).toBeGreaterThan(0);
  expect(elicitationAccepts(frames)).not.toContain(true);
  expect(readAudit(session.auditPath).some((e) => e.phase === 'execute')).toBe(false);
}

for (const adapter of adapters) {
  const interactive = adapter.interactiveArgs;
  const ready = adapter.readyPattern;
  const declineKeys = adapter.declineKeys;
  if (!interactive || !ready || !declineKeys) {
    continue;
  }

  describe.skipIf(!adapterAvailable(adapter))(`${adapter.name} (interactive TUI)`, () => {
    let dir: string;
    let child: IPty | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tnmcp-tui-'));
    });

    afterEach(() => {
      child?.kill();
      child = undefined;
      rmSync(dir, { recursive: true, force: true });
    });

    it('renders the full fan-out plan to the human before asking for approval; declining executes nothing', async () => {
      const fixture = setUpFixture(dir);
      const session = await driveToPlan(
        adapter,
        interactive(fixture),
        ready,
        fixture,
        dir,
        FULL_PROMPT,
        (pty) => {
          child = pty;
        },
      );

      // The scenario must actually be multi-system. `targets` comes from the
      // plan, and the plan reflects whatever arguments the model chose — a
      // narrowed selector would silently revert everything below to the
      // single-system coverage this suite had before, still reporting green.
      // This is not an assertion on model prose or tool choice; it is an
      // assertion that the scenario under test occurred.
      expect(session.targets, session.planMessage).toEqual(FIXTURE_SYSTEMS);

      const seen = await accumulateUntilRendered(session.screenText, [
        session.snapshotId,
        'snapshots_create',
        ...session.targets,
      ]);
      // Shape control: named like a real system, registered nowhere, so the
      // checks above cannot pass on a substring accident. The stronger
      // control — registered but untargeted — is the narrowed scenario below.
      expect(seen).not.toContain(ABSENT_SYSTEM);

      await declineAndExpectNothingExecuted(session, declineKeys);
    });

    it('a plan narrowed to one system never shows the untargeted one', async () => {
      const fixture = setUpFixture(dir);
      const session = await driveToPlan(
        adapter,
        interactive(fixture),
        ready,
        fixture,
        dir,
        NARROW_PROMPT,
        (pty) => {
          child = pty;
        },
      );

      // Same reasoning as above, mirrored: the narrowing must actually have
      // happened, or the absence assertions below are vacuous.
      expect(session.targets, session.planMessage).toEqual([NARROW_TARGET]);

      const seen = await accumulateUntilRendered(session.screenText, [
        session.snapshotId,
        'snapshots_create',
        ...session.targets,
      ]);
      // The control with teeth: connected, registered, absent from the plan.
      // Its name reaching the screen would mean the rendering (or these
      // checks) confuse the registry with the plan — the user would read an
      // approval as covering a system it does not.
      for (const name of FIXTURE_SYSTEMS.filter((n) => !session.targets.includes(n))) {
        expect(seen).not.toContain(name);
      }

      await declineAndExpectNothingExecuted(session, declineKeys);
    });
  });
}
