import { spawnSync } from 'node:child_process';
import { ALLOWED_TOOLS, hostOnPath, type FixturePaths } from './harness';

/**
 * A host adapter supplies how to point the host at the fixture, how to run
 * one non-interactive prompt, and what behavior to expect. Everything else —
 * fixture, trace, assertions — is the shared harness. Adding a host is an
 * adapter plus a matrix row, and a row is only added once probed (plan:
 * "unverified rows are candidates, not claims").
 */
export interface HostAdapter {
  name: string;
  /** Binary on PATH; the host's rows are skipped when absent. */
  command: string;
  /** Extra availability requirements beyond the binary (e.g. a local model
   * server); rows are skipped, not failed, when unmet. */
  available?(): boolean;
  /** Extra child env the host needs. */
  env?: Record<string, string>;
  /** argv for a single non-interactive (headless) prompt. */
  headlessArgs(fixture: FixturePaths, prompt: string): string[];
  /** argv to launch the interactive TUI; omit for hosts without one. */
  interactiveArgs?(fixture: FixturePaths): string[];
  /** First-run dialogs that may precede the input box (trust prompts,
   * telemetry consent). Answered at most once each, only if seen. */
  startupDialogs?: { pattern: RegExp; response: string }[];
  /** Screen pattern that means the TUI's input box is ready. */
  readyPattern?: RegExp;
  /** Keystrokes declining the rendered elicitation, sent in order. */
  declineKeys?: string[];
  /** What the host's initialize request is expected to advertise. */
  expectsElicitation: boolean;
  /**
   * Whether the host reliably exits 0 and answers elicitations with an
   * explicit action when unattended (Claude Code: action=cancel, exit 0).
   * When false, the fail-closed shape varies — goose 1.45.0 has been observed
   * both erroring out with exit 1 and no answer, and answering with a
   * JSON-RPC error then exiting 0 — so neither exit code nor answer form is
   * asserted; only the shape-agnostic invariant (no elicitation is ever
   * accepted, nothing executes, no token appears) is.
   */
  deterministicUnattendedShape: boolean;
}

/** Cheapest current Claude model — the tier-3 assertions are trace-based and
 * model-agnostic, and the session is two explicitly-prompted tool calls, so
 * the small model carries no assertion risk; override to try others. */
const CLAUDE_MODEL = process.env['TNMCP_CLAUDE_MODEL'] ?? 'claude-haiku-4-5';

export const claudeCode: HostAdapter = {
  name: 'claude-code',
  command: 'claude',
  headlessArgs: (fixture, prompt) => [
    '-p',
    prompt,
    '--model',
    CLAUDE_MODEL,
    '--mcp-config',
    fixture.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED_TOOLS,
    '--max-turns',
    '8',
    '--output-format',
    'json',
  ],
  interactiveArgs: (fixture) => [
    '--model',
    CLAUDE_MODEL,
    '--mcp-config',
    fixture.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED_TOOLS,
  ],
  // In a fresh directory the trust dialog swallows anything typed before it
  // is answered — the cause of the phase's originally inconclusive probe.
  startupDialogs: [{ pattern: /trust this folder/i, response: '\r' }],
  readyPattern: /\? for shortcuts/,
  declineKeys: ['\x1b'],
  expectsElicitation: true,
  deterministicUnattendedShape: true,
};

/** Ollama-backed model for the goose adapter; override to try others. The
 * non-thinking instruct variant is deliberate: the thinking qwen3:4b was
 * reliable but its reasoning tokens made every call take longer than the
 * test budgets on CPU-only CI runners (first nightly run timed out before
 * the first tool call completed); the instruct variant of the same family
 * went 5/5 locally at seconds per test. */
const GOOSE_MODEL = process.env['TNMCP_GOOSE_MODEL'] ?? 'qwen3:4b-instruct';

export const goose: HostAdapter = {
  name: 'goose',
  command: 'goose',
  // Needs a running ollama server with the model pulled; `ollama list`
  // fails when the server is down.
  available: () => {
    // Full model string, tag included: a base-name match would report an
    // overridden-but-unpulled tag as available and fail at runtime instead
    // of skipping.
    const list = spawnSync('ollama', ['list'], { encoding: 'utf8' });
    return list.status === 0 && list.stdout.includes(GOOSE_MODEL);
  },
  env: { GOOSE_PROVIDER: 'ollama', GOOSE_MODEL },
  headlessArgs: (fixture, prompt) => [
    'run',
    '--no-profile',
    '-q',
    '--max-turns',
    '8',
    '--with-extension',
    fixture.serverCommand,
    '-t',
    prompt,
  ],
  interactiveArgs: (fixture) => [
    'session',
    '--no-profile',
    '--with-extension',
    fixture.serverCommand,
  ],
  // First run shows a telemetry-consent dialog; right-arrow + enter answers
  // No. The approval prompt is a Yes/No selector defaulting to Yes, declined
  // the same way (probed 2026-08-10: sends action=decline).
  startupDialogs: [{ pattern: /Share anonymous usage data/i, response: '\x1b[C\r' }],
  readyPattern: /goose is ready/,
  declineKeys: ['\x1b[C', '\r'],
  // Probed 2026-08-10 (goose-cli 1.45.0): advertises elicitation — the
  // plan's "likely not" guess was wrong. Unattended it fails closed, but not
  // always the same way; see deterministicUnattendedShape.
  expectsElicitation: true,
  deterministicUnattendedShape: false,
};

export const adapters: HostAdapter[] = [claudeCode, goose];

export function adapterAvailable(adapter: HostAdapter): boolean {
  return hostOnPath(adapter.command) && (adapter.available?.() ?? true);
}
