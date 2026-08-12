import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterAvailable, adapters } from './adapters';
import {
  ABSENT_SYSTEM,
  elicitationAccepts,
  elicitationAnswers,
  hostEnv,
  readAudit,
  readTrace,
  setUpFixture,
  until,
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

const INTERACTIVE_PROMPT =
  'Call snapshots_create with dataset "tank/data", name "probe2", systems "all". ' +
  'Do not ask me anything first.';

for (const adapter of adapters) {
  const interactive = adapter.interactiveArgs;
  if (!interactive || !adapter.readyPattern || !adapter.declineKeys) {
    continue;
  }
  const ready = adapter.readyPattern;
  const declineKeys = adapter.declineKeys;

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

    it('renders the plan to the human before asking for approval; declining executes nothing', async () => {
      const fixture = setUpFixture(dir);
      const { tracePath, auditPath } = fixture;
      const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
      const pty = ptySpawn(adapter.command, interactive(fixture), {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: dir,
        env: { ...hostEnv(), ...adapter.env },
      });
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
      pty.write(INTERACTIVE_PROMPT);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      pty.write('\r');

      // The gate fires: our server sends the elicitation. Generous budget —
      // an Ollama-backed host on CI CPU can take minutes to get here.
      await until(
        () => JSON.stringify(readTrace(tracePath)).includes('elicitation/create'),
        780_000,
      );
      const elicit = readTrace(tracePath).find(
        (f) => f.dir === 'send' && f.message.method === 'elicitation/create',
      );
      expect(elicit, 'server never sent elicitation/create').toBeDefined();
      const planMessage = elicit?.message.params?.['message'] as string;

      // The strings the human must see, taken from the plan we generated:
      // the snapshot id, the tool name, and every system the plan targets —
      // read from the frame, never hard-coded, so the assertion follows the
      // fixture at any N. Deliberately not the full prose lines — the model
      // chooses the snapshot name, and pinning its exact wording would fail
      // on a paraphrase rather than on the thing under test (that the human
      // is shown what will change).
      const snapshotId = /"([^"]+@[^"]+)"/.exec(planMessage)?.[1];
      expect(snapshotId).toMatch(/^tank\/data@/);
      const targets = /^Target systems: (.+)$/m.exec(planMessage)?.[1]?.split(', ') ?? [];
      expect(targets.length, planMessage).toBeGreaterThan(0);

      // Deliberate semantics — do not "fix" this into a single-snapshot
      // check: each string must appear in the terminal text at some point
      // before approval, accumulated across polls. A fixed-size box that
      // scrolls a long plan still showed it to the human and passes; a host
      // that truncates or summarises the tail never renders the name at all
      // and fails here.
      const rendered = [snapshotId as string, 'snapshots_create', ...targets];
      let seen = '';
      await until(() => {
        seen += `\n${screenText()}`;
        return rendered.every((needle) => seen.includes(needle));
      }, 120_000);
      for (const needle of rendered) {
        expect(seen, `never rendered: ${needle}`).toContain(needle);
      }
      // The negative control: a system name the plan does not target must
      // never have appeared, so the checks above cannot pass on a substring
      // accident.
      expect(seen).not.toContain(ABSENT_SYSTEM);

      // Decline; the answer must be a non-accept and nothing executes.
      for (const key of declineKeys) {
        pty.write(key);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await until(() => elicitationAnswers(readTrace(tracePath)).length > 0, 120_000);
      const frames = readTrace(tracePath);
      expect(elicitationAnswers(frames).length).toBeGreaterThan(0);
      expect(elicitationAccepts(frames)).not.toContain(true);
      expect(readAudit(auditPath).some((e) => e.phase === 'execute')).toBe(false);
    });
  });
}
