import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Claude Code's workspace trust lives in its config, keyed by the exact
 * project path, under `projects[path].hasTrustDialogAccepted`. There is no
 * flag that sets it. The interactive trust dialog defaults to "No, exit",
 * and Enter confirms that row, so a driver that answers the dialog with
 * Enter never reaches the input box.
 *
 * Which file Claude reads, first match wins (its own resolution order):
 * `~/.claude/.config.json` when that legacy file exists, otherwise
 * `$CLAUDE_CONFIG_DIR/.claude.json` when the variable is set, otherwise
 * `~/.claude.json`. The nightly writes the onboarding flag into the last of
 * those; this merges into whichever one the child will actually open.
 */
export function claudeConfigPath(
  home: string,
  env: Record<string, string | undefined>,
  legacyExists: (path: string) => boolean = existsSync,
): string {
  const legacy = join(home, '.claude', '.config.json');
  if (legacyExists(legacy)) {
    return legacy;
  }
  const configDir = env['CLAUDE_CONFIG_DIR'];
  if (configDir) {
    return join(configDir, '.claude.json');
  }
  return join(home, '.claude.json');
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Claude config ${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Merges one trusted folder into a Claude config object. Every other key
 * is kept: `hasCompletedOnboarding`, sibling projects, and whatever else
 * the folder's own entry already held. */
export function withTrustedFolder(config: unknown, folder: string): Record<string, unknown> {
  const root = asRecord(config, 'root');
  const projects = root['projects'] === undefined ? {} : asRecord(root['projects'], 'projects');
  const entry = projects[folder] === undefined ? {} : asRecord(projects[folder], `projects[${folder}]`);
  return {
    ...root,
    projects: {
      ...projects,
      [folder]: { ...entry, hasTrustDialogAccepted: true },
    },
  };
}

/** Marks `dir` trusted for the Claude process that is about to be spawned
 * with `env`, and returns the path string recorded as the project key.
 * That string is the realpath: Claude keys trust on the cwd it was given,
 * and a symlink (`/tmp` → `/private/tmp`) would otherwise miss. */
export function trustClaudeFolder(dir: string, env: Record<string, string>): string {
  const folder = realpathSync(dir);
  const home = env['HOME'] ?? homedir();
  const configPath = claudeConfigPath(home, env);
  let parsed: unknown = {};
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8');
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Claude config at ${configPath} is not JSON; refusing to overwrite it to record workspace trust`,
      );
    }
  }
  const body = `${JSON.stringify(withTrustedFolder(parsed, folder), null, 2)}\n`;
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, configPath);
  return folder;
}
