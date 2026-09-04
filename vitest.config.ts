import { fileURLToPath } from 'node:url';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  // Resolve the tsconfig path alias explicitly; `*.spec.ts` files are excluded
  // from tsconfig.json (they live in tsconfig.spec.json), so a tsconfig-driven
  // plugin would not map `@/…` for them.
  resolve: {
    alias: [{ find: /^@\//, replacement: `${srcDir}/` }],
  },
  test: {
    environment: 'node',
    globals: true,
    // tests/helpers/ holds shared spec logic — parsers for the wire shapes the
    // tier-2 suite reads. Its own unit tests belong here in tier 0/1, not in
    // the dist tier that consumes them: they need no build and no subprocess.
    include: ['src/**/*.spec.ts', 'tests/helpers/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Narrows the untested-file scan to src. Vitest 3 already pulls
      // unimported files into the denominator via the coverage.all default;
      // vitest 4 removes that option and requires an explicit include for a
      // new src file that no spec imports to keep reporting at 0%.
      include: ['src/**/*.ts'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Re-export barrel; no logic of its own.
        'src/index.ts',
        // Subprocess-tested by cli.spec.ts, which spawns `tsx src/cli.ts`;
        // v8 coverage in the parent process cannot see into the child, so it
        // reads 0% here despite being tested. Do not "fix" this by deleting
        // those tests.
        'src/cli.ts',
        // Same situation as cli.ts: process wiring (stdio transport, signal
        // handlers, process.exit) exercised through subprocesses — startup
        // failures via cli.spec.ts today, the full session via the tier-2
        // stdio fixture. Coverage is sourced from tiers 0-1 only (coverage
        // policy rule 2 in docs/testing-plan.md) — do not "fix" this
        // exclusion by deleting the subprocess tests.
        'src/run.ts',
      ],
      // Floors, not targets: set at the measured level so a decrease fails CI.
      // Raised by hand in the same PR that raises the coverage — never lowered,
      // never auto-updated. See docs/testing-plan.md.
      // Branch is the primary gate; the statements floor exists because v8
      // reports a file that no test touches as 100% branch (no branches
      // recorded), so a branch-only floor cannot see a file losing all its
      // tests at once.
      thresholds: {
        branches: 89,
        statements: 94,
        // Per-file floors on the files where the safety model lives. A key
        // that matches no file passes vacuously, so renaming one of these
        // files must carry its key along or the floor silently disappears. Both
        // measure 100% statements today, but the statements floor is only the
        // wholesale-loss backstop, not a full-line-coverage mandate — 98
        // leaves room for an honestly-excluded defensive line.
        'src/server.ts': { branches: 98, statements: 98 },
        'src/gate.ts': { branches: 98, statements: 98 },
      },
    },
  },
});
