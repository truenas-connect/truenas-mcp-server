import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from './adapters';
import {
  elicitationAnswers,
  hostEnv,
  hostOnPath,
  readAudit,
  readTrace,
  setUpFixture,
  until,
} from './harness';

/**
 * Tier 3, interactive (testing-plan Phase 5): proves the human is actually
 * SHOWN the plan. Every lower tier stops at the wire; a host could answer the
 * protocol perfectly and render nothing useful, and the gate would be
 * technically satisfied and practically defeated. The host's output goes
 * through a real PTY into a real terminal emulator, and the assertion reads
 * the screen buffer a human would see — with the expected substrings taken
 * from the elicitation frame in our own trace, never hard-coded against TUI
 * chrome.
 *
 * Probe history (2026-08-07, settled 2026-08-08): the earlier inconclusive
 * probe died before tools/call because Claude Code renders a trust-folder
 * dialog in a fresh directory — the typed prompt landed in that dialog and
 * Enter answered it, leaving an empty input box. The driver below answers the
 * dialog first, then waits for the input box before typing.
 */

const COLS = 120;
const ROWS = 40;

describe.skipIf(!hostOnPath(claudeCode.command))('claude-code (interactive TUI)', () => {
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

  it('renders the plan to the human before asking for approval; Esc declines', async () => {
    const { mcpConfigPath, tracePath, auditPath } = setUpFixture(dir);
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    const pty = ptySpawn(
      claudeCode.command,
      claudeCode.interactiveArgs?.(mcpConfigPath) ?? [],
      { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: dir, env: hostEnv() },
    );
    child = pty;
    pty.onData((data) => term.write(data));

    const screenText = (): string => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    };

    // Reach the input box, answering the trust-folder dialog if it appears.
    let trusted = false;
    await until(() => {
      const screen = screenText();
      if (!trusted && /trust this folder/i.test(screen)) {
        pty.write('\r');
        trusted = true;
      }
      return /\? for shortcuts/.test(screen);
    }, 60_000);
    expect(screenText(), 'TUI never became ready').toMatch(/\? for shortcuts/);

    // One mutating call; the brief pause keeps the Enter from being treated
    // as part of a paste.
    pty.write(
      'Call snapshots_create with dataset "tank/data", name "probe2", systems "all". ' +
        'Do not ask me anything first.',
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    pty.write('\r');

    // The gate fires: our server sends the elicitation.
    await until(() => JSON.stringify(readTrace(tracePath)).includes('elicitation/create'), 180_000);
    const elicit = readTrace(tracePath).find(
      (f) => f.dir === 'send' && f.message.method === 'elicitation/create',
    );
    expect(elicit, 'server never sent elicitation/create').toBeDefined();
    const planMessage = elicit?.message.params?.['message'] as string;

    // The string the human must see, taken from the plan we generated: the
    // snapshot id. Deliberately not the full prose line — the model chooses
    // the snapshot name, and pinning its exact wording would fail on a
    // paraphrase rather than on the thing under test (that the human is
    // shown what will change). The tool name is the one stable literal.
    const snapshotId = /"([^"]+@[^"]+)"/.exec(planMessage)?.[1];
    expect(snapshotId).toMatch(/^tank\/data@/);

    // The rendered screen shows them before any approval happens.
    await until(() => screenText().includes(snapshotId as string), 30_000);
    const screen = screenText();
    expect(screen).toContain(snapshotId as string);
    expect(screen).toContain('snapshots_create');

    // Decline via Esc; the answer must be a non-accept and nothing executes.
    pty.write('\x1b');
    await until(() => elicitationAnswers(readTrace(tracePath)).length > 0, 60_000);
    const answers = elicitationAnswers(readTrace(tracePath));
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) {
      expect(answer).not.toBe('accept');
    }
    expect(readAudit(auditPath).some((e) => e.phase === 'execute')).toBe(false);
  });
});
