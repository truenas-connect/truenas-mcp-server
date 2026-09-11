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
  hostConnected,
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
 * The driver answers an adapter's declared startupDialogs first.
 *
 * Readiness (2026-09-10): it then waits on OUR WIRE, not on the screen. The
 * screen gate this replaced watched for a per-host banner, and when
 * claude-code's trust dialog changed its default to "No, exit" the suite's
 * bare `\r` began declining it — so the host exited, and the failure read
 * "TUI never became ready: expected '────…' to match /? for shortcuts/",
 * naming a banner that had never changed. A gate that can only see the screen
 * can only blame the screen. `hostConnected` asserts the host reached our
 * server; the screen is left to the assertions that are genuinely about what a
 * human sees.
 */

const COLS = 120;
const ROWS = 40;

/** The glyph a TUI list draws beside the selected option, and the arrow keys
 * that move it. */
const CURSOR = '\u276f';
const DOWN = '\x1b[B';
const UP = '\x1b[A';
/** Kills the current input line; readline-style boxes share this binding. */
const CLEAR_LINE = '\x15';

/** Screen text with every run of whitespace removed, so a needle can be
 * matched across the input box's wrap points. */
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

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

  // Answer first-run dialogs until the host reaches our server. Both halves
  // share one loop because the dialogs are what stand between launch and the
  // connection: an unanswered one means `hostConnected` never goes true.
  const answered = new Set<RegExp>();
  await until(() => {
    const screen = screenText();
    for (const dialog of adapter.startupDialogs ?? []) {
      if (answered.has(dialog.pattern) || !dialog.pattern.test(screen)) {
        continue;
      }
      if (dialog.choose === undefined) {
        pty.write(dialog.response);
        answered.add(dialog.pattern);
      } else if (confirmChoice(pty, screen, dialog.choose)) {
        answered.add(dialog.pattern);
      }
    }
    return hostConnected(tracePath);
  }, 120_000);
  expect(
    hostConnected(tracePath),
    `host never connected to the server; see ${fixture.hostLogPath}. Last screen:\n${screenText()}`,
  ).toBe(true);

  // One mutating call. Connected is not the same as accepting keystrokes — a
  // host can have its MCP session up while the input box is still assembling,
  // and anything typed then is swallowed — so the Enter is withheld until the
  // box demonstrably holds the prompt.
  //
  // The echo is the one screen check this driver keeps, and deliberately so:
  // it looks for OUR OWN text coming back, which cannot go stale the way a
  // banner can. Whitespace is stripped from both sides because the box wraps
  // at the terminal width and a fixed needle would straddle the fold.
  //
  // This also replaces the fixed pause that used to stand in for it. A timer
  // is a guess about a machine that may be slower than the one it was tuned
  // on; an echo is the fact the timer was approximating.
  const typed = (): boolean => squash(screenText()).includes(squash(prompt));
  pty.write(prompt);
  await until(typed, 30_000);
  if (!typed()) {
    // Still assembling when we typed. Clear whatever fragment landed, so the
    // retry cannot leave the box holding the prompt twice, and type again.
    pty.write(CLEAR_LINE);
    pty.write(prompt);
    await until(typed, 30_000);
  }
  expect(
    typed(),
    `the prompt never reached the input box; see ${fixture.hostLogPath}. Last screen:\n${screenText()}`,
  ).toBe(true);
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

/**
 * Moves a vertical list dialog's selection onto the option matching `choose`
 * and confirms it, one step per poll; returns whether it confirmed.
 *
 * Answering by option text rather than by position is the point. The previous
 * approach pressed Enter on whatever was selected, which silently inverted
 * when claude-code's trust dialog changed its default from the accepting
 * option to "No, exit".
 *
 * Assumes the cursor glyph appears once on a dialog screen. If the list will
 * not move the cursor onto the option, the caller's `until` budget expires and
 * the failure names the connection that never happened, with the host's own
 * log alongside it.
 */
function confirmChoice(pty: IPty, screen: string, choose: RegExp): boolean {
  const lines = screen.split('\n');
  const target = lines.findIndex((line) => choose.test(line));
  const cursor = lines.findIndex((line) => line.includes(CURSOR));
  if (target < 0 || cursor < 0) {
    return false;
  }
  if (cursor === target) {
    pty.write('\r');
    return true;
  }
  pty.write(cursor < target ? DOWN : UP);
  return false;
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
  const declineKeys = adapter.declineKeys;
  if (!interactive || !declineKeys) {
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
