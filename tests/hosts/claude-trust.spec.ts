import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeConfigPath, trustClaudeFolder, withTrustedFolder } from './claude-trust';

describe('claudeConfigPath', () => {
  const home = '/home/runner';

  it('uses ~/.claude.json when nothing else is configured', () => {
    expect(claudeConfigPath(home, {}, () => false)).toBe('/home/runner/.claude.json');
  });

  it('uses $CLAUDE_CONFIG_DIR/.claude.json when that variable is set', () => {
    expect(claudeConfigPath(home, { CLAUDE_CONFIG_DIR: '/opt/claude' }, () => false)).toBe(
      '/opt/claude/.claude.json',
    );
  });

  it('prefers the legacy ~/.claude/.config.json when that file exists', () => {
    expect(claudeConfigPath(home, { CLAUDE_CONFIG_DIR: '/opt/claude' }, () => true)).toBe(
      '/home/runner/.claude/.config.json',
    );
  });
});

describe('withTrustedFolder', () => {
  it('records the folder and keeps the rest of the config', () => {
    const next = withTrustedFolder(
      {
        hasCompletedOnboarding: true,
        projects: {
          '/other': { hasTrustDialogAccepted: false, projectOnboardingSeenCount: 4 },
          '/work': { allowedTools: ['Read'] },
        },
      },
      '/work',
    );
    expect(next).toEqual({
      hasCompletedOnboarding: true,
      projects: {
        '/other': { hasTrustDialogAccepted: false, projectOnboardingSeenCount: 4 },
        '/work': { allowedTools: ['Read'], hasTrustDialogAccepted: true },
      },
    });
  });

  it('starts from an empty object when the file has not been written yet', () => {
    expect(withTrustedFolder({}, '/work')).toEqual({
      projects: { '/work': { hasTrustDialogAccepted: true } },
    });
  });

  it.each([
    ['root', []],
    ['projects', { projects: [] }],
    ['folder entry', { projects: { '/work': 'yes' } }],
  ])('refuses a %s that is not an object', (_name, config) => {
    expect(() => withTrustedFolder(config, '/work')).toThrow(/not a JSON object/);
  });
});

describe('trustClaudeFolder', () => {
  function tempHome(): string {
    return mkdtempSync(join(tmpdir(), 'tnmcp-claude-home-'));
  }

  it('merges trust into the config file the child will read', () => {
    const home = tempHome();
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'tnmcp-claude-work-')));
    writeFileSync(join(home, '.claude.json'), '{"hasCompletedOnboarding": true}\n');

    const recorded = trustClaudeFolder(work, { HOME: home });

    const written = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      hasCompletedOnboarding: boolean;
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(recorded).toBe(work);
    expect(written.hasCompletedOnboarding).toBe(true);
    expect(written.projects[work]?.hasTrustDialogAccepted).toBe(true);
  });

  it('writes the legacy config when that file is the one Claude opens', () => {
    const home = tempHome();
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'tnmcp-claude-work-')));
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.config.json'), '{}\n');
    writeFileSync(join(home, '.claude.json'), '{"untouched": true}\n');

    trustClaudeFolder(work, { HOME: home });

    const legacy = JSON.parse(readFileSync(join(home, '.claude', '.config.json'), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    const ignored = readFileSync(join(home, '.claude.json'), 'utf8');
    expect(legacy.projects[work]?.hasTrustDialogAccepted).toBe(true);
    expect(ignored).toBe('{"untouched": true}\n');
  });

  it('leaves a non-JSON config untouched', () => {
    const home = tempHome();
    const work = mkdtempSync(join(tmpdir(), 'tnmcp-claude-work-'));
    const path = join(home, '.claude.json');
    writeFileSync(path, 'not json');

    expect(() => trustClaudeFolder(work, { HOME: home })).toThrow(/not JSON/);
    expect(readFileSync(path, 'utf8')).toBe('not json');
  });
});
